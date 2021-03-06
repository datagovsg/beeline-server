/* eslint require-jsdoc: 0 */
let _ = require("lodash")
let Joi = require("joi")
let Boom = require("boom")
const assert = require("assert")

const auth = require("../core/auth")
const { getModels, getDB, defaultErrorHandler } = require("../util/common")
const {
  handleRequestWith,
  instToJSONOrNotFound,
  deleteInst,
} = require("../util/endpoints")

import * as events from "../events/events"

import { InvalidArgumentError } from "../util/errors"

export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/trips/{id}/code",
    config: {
      tags: ["api", "admin", "commuter", "driver"],
      description: "Update a route (for admin and superadmin only)",
      auth: { access: { scope: ["user", "admin", "superadmin", "driver"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        if (request.auth.credentials.role === "user") {
          // ensure that user has such a ticket
          let ticket = await m.Ticket.find({
            include: [
              {
                model: m.Trip,
                where: {
                  id: request.params.id,
                },
              },
            ],
            where: {
              userId: request.auth.credentials.userId,
              status: "valid",
            },
          })
          if (!ticket) {
            return reply(
              Boom.forbidden("You do not have a ticket for this trip")
            )
          }
        }

        let trip = await m.Trip.findById(request.params.id)

        return reply(trip.getCode(true))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/trips",
    config: {
      tags: ["api", "admin", "commuter"],
      auth: false,
      validate: {
        query: {
          driverId: Joi.number()
            .integer()
            .optional(),
          startDate: Joi.date().default(new Date()),
          endDate: Joi.date().optional(),
          limit: Joi.number()
            .integer()
            .default(20)
            .max(20)
            .min(1),
          offset: Joi.number()
            .integer()
            .default(0)
            .min(0),

          // Retrieval options
          includeCompany: Joi.boolean().default(false),
        },
      },
    },

    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let query = {
          where: {},
          include: [{ model: m.TripStop, include: [{ model: m.Stop }] }],
          limit: request.query.limit,
          offset: request.query.offset,
          order: [["date"], ["id"]],
        }

        /* Populate the query with params */
        if (request.query.driverId) {
          query.where.driverId = request.query.driverId
        }
        if (request.query.startDate) {
          query.where.date = query.where.date || {}
          query.where.date.$gte = request.query.startDate
        }
        if (request.query.endDate) {
          query.where.date = query.where.date || {}
          query.where.date.$lte = request.query.endDate
        }
        if (request.query.includeCompany) {
          query.include.push({
            model: m.TransportCompany,
            attribute: { exclude: ["logo"] },
          })
        }

        let trips = m.Trip.findAll(query)

        reply(trips.map(t => t.toJSON()))
      } catch (error) {
        console.error(error.stack)
        defaultErrorHandler(reply)(error)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/trips/{id}",
    config: {
      tags: ["api", "admin", "commuter"],
      auth: false,
      validate: {
        params: {
          id: Joi.number(),
        },
        query: Joi.object({
          includeCompany: Joi.boolean().default(false),
          includeVehicle: Joi.boolean().default(false),
          includeDriver: Joi.boolean().default(false),
        }).unknown(),
      },
    },
    handler: handleRequestWith((ignored, request, { models: m }) => {
      let query = {
        include: [
          {
            model: m.TripStop,
            include: [{ model: m.Stop }],
          },
          m.Route,
        ],
        order: [[m.TripStop, "time"]],
      }

      if (request.query.includeCompany) {
        query.include.push({
          model: m.TransportCompany,
          attributes: { exclude: ["logo"] },
        })
      }

      if (request.query.includeDriver) {
        query.include.push(m.Driver)
      }

      if (request.query.includeVehicle) {
        query.include.push(m.Vehicle)
      }

      return m.Trip.findById(request.params.id, query)
    }, instToJSONOrNotFound),
  })

  server.route({
    method: "POST",
    path: "/trips",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        payload: {
          date: Joi.date(),
          routeId: Joi.number()
            .integer()
            .required(),
          capacity: Joi.number()
            .integer()
            .required(),
          price: Joi.number().required(),
          status: Joi.string()
            .allow("")
            .allow(null),
          vehicleId: Joi.number()
            .integer()
            .allow(null),
          driverId: Joi.number()
            .integer()
            .allow(null),

          // A trip has at least two stops - boarding and alighting
          tripStops: Joi.array()
            .min(2)
            .items({
              stopId: Joi.number()
                .integer()
                .required(),
              time: Joi.date().required(),
              canBoard: Joi.boolean().required(),
              canAlight: Joi.boolean().required(),
            }),
          bookingInfo: Joi.object({
            windowType: Joi.string()
              .valid(["stop", "firstStop"])
              .default("stop"),
            windowSize: Joi.number()
              .integer()
              .default(-300000),
            notes: Joi.string()
              .allow("")
              .allow(null)
              .default(null),
            childTicketPrice: Joi.number().allow(null),
          })
            .optional()
            .allow(null),
        },
      },
    },
    handler: async function(request, reply) {
      let m = getModels(request)

      try {
        let trip = request.payload
        trip.seatsAvailable = trip.capacity

        // Ensure that route doens't belong to another company too
        let r = await m.Route.findById(request.payload.routeId)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-routes",
          r.transportCompanyId,
          true,
          "Route belongs to a different company"
        )

        let tripInst = await m.Trip.create(trip, {
          include: [
            {
              model: m.TripStop,
              // Stops shouldn't be created here, generally speaking,
              // because we are then more likely to have many duplicate stops
              // FIXME Fix this when we are interested in more dynamic routing
              // include: [{model: m.Stop}]
            },
          ],
        })

        return reply(tripInst.toJSON())
      } catch (error) {
        defaultErrorHandler(reply)(error)
      }
    },
  })

  server.route({
    method: "DELETE",
    path: "/trips/{id}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number(),
        },
      },
    },
    handler: handleRequestWith(
      request =>
        getModels(request).Trip.findById(request.params.id, {
          include: [
            {
              model: getModels(request).Route,
              attributes: ["transportCompanyId"],
            },
          ],
        }),
      async (trip, request) => {
        if (trip) {
          await auth.assertAdminRole(
            request.auth.credentials,
            "manage-routes",
            trip.route.transportCompanyId,
            true,
            "Route belongs to a different company"
          )
        }
        return trip
      },
      deleteInst
    ),
  })

  // FIXME: In production EITHER use set_vehicle or set_vehicle2, but not both!
  // Or disallow drivers from using set_vehicle
  server.route({
    method: "POST",
    path: "/trips/{id}/setVehicle",
    config: {
      tags: ["api", "admin"],
      description: `Set the driver of a trip. If you are logged on as a driver
your driver ID is used automatically. Otherwise you must pass
a driver ID in the payload.

Trip's company ID and driver's company ID must match.
`,
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: Joi.object({
          id: Joi.number()
            .integer()
            .required(),
        }),
        payload: Joi.object({
          vehicleId: Joi.number()
            .integer()
            .required(),
        }).unknown(),
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        let vehicle = await m.Vehicle.findById(request.payload.vehicleId)

        if (
          vehicle == null ||
          (request.auth.credentials.role === "driver" &&
            vehicle.driverId !== request.auth.credentials.driverId)
        ) {
          throw new Error("Vehicle does not belong to driver")
        }

        let driver = await m.Driver.findById(vehicle.driverId)
        let trip = await m.Trip.findById(request.params.id, {
          include: [
            {
              model: m.Route,
              attributes: ["transportCompanyId"],
            },
          ],
        })

        await auth.assertAdminRole(
          request.auth.credentials,
          "drive",
          trip.route.transportCompanyId
        )

        trip.vehicleId = vehicle.id
        trip.driverId = driver.id
        await trip.save()
        reply(trip.toJSON())
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  server.route({
    method: "GET",
    path: "/trips/{id}/passengers",
    config: {
      tags: ["api", "admin", "driver"],
      auth: { access: { scope: ["admin", "superadmin", "driver"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      try {
        const tripId = request.params.id
        const models = getModels(request)
        const trip = await models.Trip.findById(tripId, {
          attributes: ["routeId"],
          include: [
            {
              model: models.Route,
              attributes: ["transportCompanyId"],
            },
          ],
        })
        await auth.assertAdminRole(
          request.auth.credentials,
          "view-passengers",
          trip.route.transportCompanyId
        )

        const db = getDB(request)
        const tripTickets = await db.query(
          `SELECT
            "users"."id",
            "users"."email" AS "email",
            "users"."name" AS "name",
            "users"."telephone" AS "telephone",
            "tickets"."userId" AS "userId",
            "tickets"."id" AS "ticketId",
            "tickets"."boardStopId" AS "boardStopId",
            "tickets"."alightStopId" AS "alightStopId",
            "stops"."id" AS "bsStopId",
            "tripStops"."tripId" AS "tripId"
          FROM
            "tickets", users, "tripStops", "stops"
          WHERE
            "tickets"."status" = 'valid' AND
            "tripId" = :tripId AND
            "users".id = "tickets"."userId" AND
            "tripStops"."stopId" = "stops"."id" AND
            "tripStops".id = "tickets"."boardStopId"`,
          {
            type: db.QueryTypes.SELECT,
            replacements: { tripId },
          }
        )

        reply(tripTickets)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/trips/{id}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        // FIXME: Use PATCH semantics for tripStops, capacity
        payload: {
          // A trip has at least two stops - boarding and alighting
          tripStops: Joi.array()
            .min(2)
            .items(
              Joi.object({
                id: Joi.number()
                  .integer()
                  .allow(null)
                  .required(),
                time: Joi.date().optional(),
                stopId: Joi.number()
                  .integer()
                  .optional(),
                canBoard: Joi.boolean().optional(),
                canAlight: Joi.boolean().optional(),
              }).unknown()
            )
            .required(),

          // routeId: Joi.number().integer().required(),
          capacity: Joi.number()
            .integer()
            .default(null),
          status: Joi.string()
            .allow("")
            .allow(null),
          vehicleId: Joi.number()
            .integer()
            .allow(null),
          driverId: Joi.number()
            .integer()
            .allow(null),
          price: Joi.number(),
          date: Joi.date(),
          bookingInfo: Joi.object({
            windowType: Joi.string()
              .valid(["stop", "firstStop"])
              .default("stop"),
            windowSize: Joi.number()
              .integer()
              .default(-300000),
            notes: Joi.string()
              .allow("")
              .allow(null)
              .default(null),
            childTicketPrice: Joi.number().allow(null),
          })
            .optional()
            .allow(null),
        },
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let db = getDB(request)

        // ensure that if admin, admin can only modify trips belonging
        // to his company
        let tripInst = await m.Trip.findById(request.params.id, {
          include: [
            {
              model: m.Route,
              attributes: ["transportCompanyId"],
            },
          ],
        })

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-routes",
          tripInst.route.transportCompanyId
        )

        // tripStops should not change tripIds
        let tsIds = request.payload.tripStops
          .map(ts => ts.id)
          .filter(id => id !== null && id !== undefined)
        let notFromThisTrip = await m.TripStop.find({
          where: {
            id: { $in: tsIds },
            tripId: { $ne: request.params.id },
          },
        })
        assert(!notFromThisTrip, "TripStop belongs to another Trip")

        // adjust seatsAvailable by change in capacity, if any
        if (request.payload.capacity != null) {
          const capacityChange = request.payload.capacity - tripInst.capacity
          InvalidArgumentError.assert(
            -capacityChange <= tripInst.seatsAvailable,
            "Decrease in capacity cannot be greater than seats available"
          )
          request.payload.seatsAvailable =
            tripInst.seatsAvailable + capacityChange
        }

        // Don't allow trip dates to change if there are bookings
        if (
          request.payload.date !== undefined &&
          request.payload.date.getTime() !== tripInst.date.getTime()
        ) {
          const ticketCountForTrip = await db.query(
            `
          SELECT COUNT(*) AS count
          FROM tickets INNER JOIN "tripStops" ON "tripStops".id = tickets."boardStopId"
            INNER JOIN trips on "tripStops"."tripId" = trips.id
          WHERE trips.id = :tripId
            AND tickets.status IN ('valid', 'refunded')
            `,
            {
              type: db.QueryTypes.SELECT,
              replacements: { tripId: request.params.id },
              logging: true,
            }
          )
          InvalidArgumentError.assert(
            ticketCountForTrip[0].count === "0",
            "You may not change the date of a trip if there are bookings"
          )
        }

        // otherwise...
        await db.transaction(async t => {
          // Update trip
          await tripInst.update(request.payload, {
            transaction: t,
          })

          // Delete the stops removed from the list
          await m.TripStop.destroy({
            where: {
              ...(tsIds.length ? { id: { $notIn: tsIds } } : {}),
              tripId: tripInst.id,
            },
            transaction: t,
          })

          // update/add the rest in
          let updatePromises = request.payload.tripStops.map(async ts => {
            let update = _.pick(ts, ["canBoard", "canAlight", "time", "stopId"])
            update.tripId = request.params.id

            if (update.time) {
              // Get the trip
              // ensure that the date is within 26 hours of the trip (give and
              // take some time past midnight to account for midnight trips)
              let tripInst = await m.Trip.findById(request.params.id, {
                transaction: t,
              })

              if (
                ts.time.getTime() - tripInst.date.getTime() <=
                  -8 * 3600 * 1000 ||
                ts.time.getTime() - tripInst.date.getTime() >= 18 * 3600 * 1000
              ) {
                throw new Error("Invalid time for trip")
              }
            }

            if (ts.id) {
              // trip stop ID exists -- update
              return await m.TripStop.update(update, {
                where: {
                  id: ts.id,
                },
                transaction: t,
              })
            } else {
              return await m.TripStop.create(update, { transaction: t })
            }
          })
          return Promise.all(updatePromises)
        })
        reply(
          (await m.Trip.findById(request.params.id, {
            include: [m.TripStop],
          })).toJSON()
        )
      } catch (error) {
        defaultErrorHandler(reply)(error)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/trips/{id}/messagePassengers",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        payload: {
          message: Joi.string().required(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let tripInst = await m.Trip.findById(request.params.id, {
          include: [m.Route],
        })

        await auth.assertAdminRole(
          request.auth.credentials,
          "message-passengers",
          tripInst.route.transportCompanyId
        )

        await tripInst.messagePassengers(request.payload.message, {
          sender: request.auth.credentials.email,
        })

        events.emit("passengersMessaged", {
          message: request.payload.message,
          sender: request.auth.credentials.email,
          trip: {
            numPassengers: (await tripInst.getPassengers()).length,
            ...tripInst.toJSON(),
          },
        })

        reply(request.payload.message)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/trips/{id}/setDriver",
    config: {
      tags: ["api", "driver"],
      description: `Set the driver of a trip.
`,
      auth: { access: { scope: ["driver"] } },
      validate: {
        params: Joi.object({
          id: Joi.number()
            .integer()
            .required(),
        }),
        payload: {
          vehicleId: Joi.number()
            .integer()
            .optional(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        let driver = await m.Driver.findById(
          request.auth.credentials.driverId,
          {
            include: [m.Vehicle],
          }
        )

        // verify the trip transportCompanyId matches driver transportCompanyId
        let trip = await m.Trip.findById(request.params.id, {
          include: [
            {
              model: m.TripStop,
              include: [{ model: m.Stop }],
            },
            m.Route,
          ],
          order: [[m.TripStop, "time"]],
        })

        if (!driver) {
          return reply(Boom.notFound())
        }

        if (
          request.payload.vehicleId &&
          !driver.vehicles.find(v => v.id === request.payload.vehicleId)
        ) {
          return reply(Boom.badRequest("vehicle does not belong to driver"))
        }

        if (
          request.auth.credentials.transportCompanyIds.indexOf(
            trip.route.transportCompanyId
          ) === -1
        ) {
          return reply(
            Boom.forbidden(
              `Driver is disallowed from driving trip ${trip.id} for company ${
                trip.route.transportCompanyId
              }, ` +
                `can only drive for ${JSON.stringify(
                  request.auth.credentials.transportCompanyIds
                )}`
            )
          )
        }

        trip.driverId = request.auth.credentials.driverId
        trip.vehicleId = request.payload.vehicleId
        await trip.save()
        reply(trip.toJSON())
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-trips",
}
