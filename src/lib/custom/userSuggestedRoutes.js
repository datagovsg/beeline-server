import _ from "lodash"
import Joi from "joi"
import {
  getModels, getDB,
  defaultErrorHandler,
  InvalidArgumentError, SecurityError
} from '../util/common'

export function register (server, options, next) {
  server.route({
    method: "POST",
    path: "/modules/user_suggestions/routes",
    config: {
      tags: ['api'],
      auth: {
        mode: 'required',
        strategies: ['auth0web'],
        scope: 'email',
      },
      validate: {
        payload: {
          name: Joi.string().required(),
          busStops: Joi.array().items({
            coordinates: {
              type: Joi.valid(['Point']).required(),
              coordinates: Joi.array().length(2).items(Joi.number()).required(),
            },
            arriveAt: Joi.number().integer().required()
          }).required(),
          path: Joi.object({
            type: Joi.valid(['LineString']).required(),
            coordinates: Joi.array().min(2).items(
              Joi.array().length(2).items(Joi.number())
            ).required()
          }).required()
        }
      },
      description: 'Create a route owned by the currently logged-in user'
    },
    async handler (request, reply) {
      try {
        const m = getModels(request)
        const db = getDB(request)

        const mappedToStops = await Promise.all(request.payload.busStops.map(async busStop => {
          const startXY = busStop.coordinates.coordinates
          const distanceExpr = `ST_distance(
            ST_Transform(ST_SetSRID(stop.coordinates, 4326), 3414),
            ST_Transform(ST_SetSRID(ST_GeomFromText('POINT(${startXY[0]} ${startXY[1]})'), 4326), 3414)
          )`

          const matchingStop = await m.Stop.find({
            where: [
              `${distanceExpr} < 10`
            ],
            order: [
              [db.literal(distanceExpr), 'DESC']
            ],
          })

          return {
            stopId: matchingStop.id,
            arriveAt: busStop.arriveAt,
          }
        }))

        for (let [originalRequest, stop] of _.zip(request.payload.busStops, mappedToStops)) {
          InvalidArgumentError.assert(
            stop,
            `Could not find a matching stop for ${originalRequest.coordinates.coordinates.join(',')}`
          )
        }

        const userSuggestedRoute = await m.UserSuggestedRoute.create({
          email: request.auth.credentials.email,
          name: request.payload.name,
          path: request.payload.path,
          userSuggestedRouteStops: mappedToStops
        }, {
          include: m.UserSuggestedRouteStop
        })

        reply(userSuggestedRoute.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/modules/user_suggestions/routes",
    config: {
      tags: ['api'],
      auth: {
        mode: 'required',
        strategies: ['auth0web'],
        scope: 'email',
      },
      description: 'Lists the routes owned by the currently logged-in user'
    },
    async handler (request, reply) {
      try {
        const m = getModels(request)

        const userSuggestedRoutes = await m.UserSuggestedRoute.findAll({
          where: {
            email: request.auth.credentials.email,
          },
          include: [{
            model: m.UserSuggestedRouteStop,
            include: [m.Stop]
          }],
          order: [
            [m.UserSuggestedRouteStop, 'arriveAt', 'asc']
          ]
        })

        reply(userSuggestedRoutes.map(r => r.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "DELETE",
    path: "/modules/user_suggestions/routes/{routeId}",
    config: {
      tags: ['api'],
      auth: {
        mode: 'required',
        strategies: ['auth0web'],
        scope: 'email',
      },
      validate: {
        params: {
          routeId: Joi.number().integer().required()
        }
      },
      description: 'Deletes a route owned by the currently logged-in user'
    },
    async handler (request, reply) {
      try {
        const m = getModels(request)

        const userSuggestedRoute = await m.UserSuggestedRoute.findById(request.params.routeId, {
          include: [{
            model: m.UserSuggestedRouteStop,
            include: [m.Stop]
          }],
          order: [
            [m.UserSuggestedRouteStop, 'arriveAt', 'asc']
          ]
        })

        SecurityError.assert.strictEqual(request.auth.credentials.email, userSuggestedRoute.email)

        await Promise.all(userSuggestedRoute.userSuggestedRouteStops.map(usrs => usrs.destroy()))
        await userSuggestedRoute.destroy()

        reply()
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}

register.attributes = {
  name: "custom-user-suggested-routes"
}
