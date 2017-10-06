var Joi = require("joi")
var {getModels} = require("../util/common")
var Boom = require("boom")

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/trips/{id}/pingsByDriverId",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        params: {
          id: Joi.number().integer()
        },
        query: Joi.object({
          limit: Joi.number().integer().default(100),
          startTime: Joi.date(),
          endTime: Joi.date()
        }).unknown()
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var whereClause

        var tripInst = await m.Trip.findById(request.params.id)

        if (!tripInst.driverId) {
          return reply([])
        }
        whereClause = {
          driverId: tripInst.driverId
        }

        if (request.query.endTime || request.query.startTime) { whereClause.time = {} }
        if (request.query.endTime) whereClause.time.$lt = request.query.endTime
        if (request.query.startTime) whereClause.time.$gte = request.query.startTime

        var pings = await m.Ping.findAll({
          where: whereClause,
          order: [
            ["time", "DESC"]
          ],
          limit: request.query.limit
        })

        reply(pings.map(ping => ping.toJSON()))
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  server.route({
    method: "GET",
    path: "/trips/{id}/pingsByTripId",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        params: {
          id: Joi.number().integer()
        },
        query: Joi.object({
          limit: Joi.number().integer().default(100),
          startTime: Joi.date(),
          endTime: Joi.date()
        }).unknown()
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var whereClause

        whereClause = {
          tripId: request.params.id
        }

        if (request.query.endTime || request.query.startTime) { whereClause.time = {} }
        if (request.query.endTime) whereClause.time.$lt = request.query.endTime
        if (request.query.startTime) whereClause.time.$gte = request.query.startTime

        var pings = await m.Ping.findAll({
          where: whereClause,
          order: [
            ["time", "DESC"]
          ],
          limit: request.query.limit
        })

        reply(pings.map(ping => ping.toJSON()))
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })


  server.route({
    method: "GET",
    path: "/trips/{id}/pings",
    config: {
      tags: ["api", "deprecated"],
      auth: false,
      validate: {
        params: {
          id: Joi.number().integer()
        },
        query: Joi.object({
          byTripId: Joi.boolean().description(
            `Normally, trips are matched to pings by the driver id. This flags
             causes pings to be matched by driver id`),
          limit: Joi.number().integer().default(100),
          startTime: Joi.date(),
          endTime: Joi.date()
        }).unknown()
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var whereClause

        if (request.query.byTripId) {
          whereClause = {
            tripId: request.params.id
          }
        } else {
          var tripInst = await m.Trip.findById(request.params.id)

          if (!tripInst.driverId) {
            return reply([])
          }
          whereClause = {
            driverId: tripInst.driverId
          }
        }

        if (request.query.endTime || request.query.startTime) { whereClause.time = {} }
        if (request.query.endTime) whereClause.time.$lt = request.query.endTime
        if (request.query.startTime) whereClause.time.$gte = request.query.startTime

        var pings = await m.Ping.findAll({
          where: whereClause,
          order: [
            ["time", "DESC"]
          ],
          limit: request.query.limit
        })

        reply(pings.map(ping => ping.toJSON()))
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  /** Create a new ping. TODO: Use UDP pings? **/
  server.route({
    method: "POST",
    path: "/trips/{id}/pings",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["driver"]} },
      validate: {
        payload: Joi.object({
          vehicleId: Joi.number().integer().default(0),
          latitude: Joi.number(),
          longitude: Joi.number()
        })
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)

        var [driver, vehicle, trip] = await Promise.all([
          m.Driver.findById(request.auth.credentials.driverId),
          request.payload.vehicleId ? m.Vehicle.findById(request.payload.vehicleId) : null,
          m.Trip.findById(request.params.id)])

        if (driver.id !== trip.driverId) {
          return reply(Boom.resourceGone())
        }

        if (request.payload.vehicleId && (!vehicle || vehicle.driverId !== driver.id)) {
          return reply(Boom.badRequest("Vehicle does not belong to driver"))
        }

        var ping = await m.Ping.create({
          driverId: driver.id,
          tripId: trip.id,
          vehicleId: request.payload.vehicleId,
          coordinates: (isFinite(request.payload.latitude) &&
                        isFinite(request.payload.longitude))
            ? {
              type: "POINT",
              coordinates: [
                request.payload.longitude,
                request.payload.latitude
              ]
            } : null

        })

        reply(ping.toJSON())
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  next()
}

register.attributes = {
  name: "endpoint-pings"
}
