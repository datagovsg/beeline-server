import _ from "lodash"
import Joi from "joi"
import Boom from "boom"
import leftPad from "left-pad"
import assert from "assert"

import { getModels } from "../util/common"
import * as events from "../events/events"

const auth = require("../core/auth")

/**
 * @param {Object} server - a HAPI server
 * @param {Object} options - unused for now
 * @param {Function} next - a callback to signal that the next middleware
 * should initialise
 */
export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/trips/{id}/statuses",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        query: {
          limit: Joi.number()
            .integer()
            .min(1)
            .max(20)
            .default(10),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let whereClause = {
          tripId: request.params.id,
        }

        let tripStatuses = await m.TripStatus.findAll({
          where: whereClause,
          order: [["time", "DESC"]],
          limit: request.query.limit,
        })

        reply(tripStatuses.map(tripStatus => tripStatus.toJSON()))
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  /** Create a new tripStatus. TODO: Use UDP tripStatuses? **/
  server.route({
    method: "POST",
    path: "/trips/{id}/statuses",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
      validate: {
        payload: Joi.object({
          message: Joi.string().allow(""),
          // vehicleId: Joi.number().integer(),
          adminId: Joi.string(),
          status: Joi.string(),
          transportCompanyId: Joi.number().integer(),
        }),
        query: {
          messagePassengers: Joi.boolean().optional(),
        },
      },
    },
    // FIXME: for creator use the username or something
    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let creator = null
        let tripInst = await m.Trip.findById(request.params.id, {
          include: [
            {
              model: m.TripStop,
              include: [m.Stop],
            },
            m.Route,
          ],
          order: [[m.TripStop, "time"]],
        })

        if (request.auth.credentials.scope === "admin") {
          creator = request.auth.credentials.adminId || "admin"
          await auth.assertAdminRole(
            request.auth.credentials,
            "update-trip-status",
            tripInst.route.transportCompanyId
          )
        } else if (request.auth.credentials.scope === "driver") {
          let driverInst = await m.Driver.findById(
            request.auth.credentials.driverId
          )

          creator = `Driver ${driverInst.id} (${driverInst.name})`

          assert.equal(tripInst.driverId, driverInst.id)
        } else if (request.auth.credentials.scope === "superadmin") {
          creator = `Beeline SuperAdmin ${request.auth.credentials.email}`
        }

        // Add a trip status
        let data = _.extend({}, request.payload, {
          creator,
          tripId: request.params.id,
        })
        let [, tripStatusInst] = await Promise.all([
          // update the trip object
          tripInst.update({
            status: request.payload.status,
          }),
          // add an entry to its status update
          m.TripStatus.create(data),
        ])

        if (request.payload.status === "cancelled") {
          // Get the number of passengers -- mandatory for event
          const numPassengers = await m.Ticket.count({
            where: { status: "valid" },
            include: [
              {
                model: m.TripStop,
                as: "boardStop",
                where: { tripId: tripInst.id },
              },
            ],
          })
          events.emit("tripCancelled", {
            trip: _.assign(tripInst.toJSON(), { numPassengers }),
          })
        }

        if (
          request.query.messagePassengers &&
          request.payload.status === "cancelled"
        ) {
          let route = tripInst.route
          let firstStop = tripInst.tripStops[0]
          let time =
            leftPad(firstStop.time.getHours(), 2, "0") +
            ":" +
            leftPad(firstStop.time.getMinutes(), 2, "0")

          let messageBody =
            `(DO NOT REPLY) Attention: The service for today ` +
            `has been cancelled due to unforeseen circumstances. Please make ` +
            `alternative transport arrangements. Today's fare will be refunded ` +
            `and we sincerely apologise for the inconvenience caused to all our commuters.`

          await tripInst.messagePassengers(messageBody, {
            sender: creator,
            ccDetail: `${route.label}: ${route.from} - ${route.to} @${time}`,
          })
        }

        reply(tripStatusInst.toJSON())
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-trip-statuses",
}
