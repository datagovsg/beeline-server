const _ = require("lodash")
const Joi = require("joi")
const Boom = require("boom")

const { getModels, defaultErrorHandler } = require("../util/common")
const { cachedFetchRoutes, filterCached } = require("../listings/routes")

/**
 * @param {Object} server - a HAPI server
 * @param {Object} options - unused for now
 * @param {Function} next - a callback to signal that the next middleware
 * should initialise
 */
export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/routes/lite",
    config: {
      validate: {
        query: {
          label: Joi.string(),
          startDate: Joi.date(),
        },
      },
      auth: { access: { scope: ["user", "public"] } },
      description: "Lists all lite routes, including subscription information",
      tags: ["api"],
    },
    handler: async function(request, reply) {
      request.query.tags = request.query.tags || []
      request.query.tags.push("lite")
      request.query.includeTrips = true
      const routes = await cachedFetchRoutes(request)
        .then(routes => filterCached(routes, request))
        .then(routes => routes.map(route => _.omit(route, ["tags", "id"])))

      const subLabels = []
      const { userId } = request.auth.credentials
      if (userId) {
        const models = getModels(request)
        const subQuery = { where: { userId, status: "valid" } }
        if (request.query.label) {
          subQuery.where.routeLabel = request.query.label
        }
        const subscriptions = await models.Subscription.findAll(subQuery)
        subLabels.push(...subscriptions.map(s => s.routeLabel))
      }

      const routesByLabel = _(routes)
        .groupBy("label")
        .mapValues(routes => {
          const [route] = routes
          if (routes.length > 1) {
            route.trips = _(routes)
              .flatMap(r => r.trips)
              .sortBy("date")
              .value()
          }
          const minTripDate = _.min(route.trips.map(trip => trip.date))
          const tripsAtMinTripDate = route.trips.filter(
            trip => trip.date === minTripDate
          )
          const tripStops = _.flatMap(tripsAtMinTripDate, "tripStops")
          route.stops = _(tripStops)
            .groupBy(ts => ts.stop.id)
            .mapValues(tripStopsAtStop => {
              const [{ stop, canBoard }] = tripStopsAtStop
              stop.canBoard = canBoard
              stop.time = _(tripStopsAtStop)
                .map("time")
                .uniq()
                .sort()
                .value()
              return stop
            })
            .values()
            .value()
          delete route.trips

          const tripStopTimes = tripStops.map(t => t.time)
          route.startTime = _.min(tripStopTimes)
          route.endTime = _.max(tripStopTimes)

          route.isSubscribed = subLabels.includes(route.label)
          return route
        })
        .value()
      reply(routesByLabel)
    },
  })

  server.route({
    method: "GET",
    path: "/routes/lite/subscriptions",
    config: {
      auth: { access: { scope: ["user"] } },
      description: "Lists all current subscriptions tied to a user",
      tags: ["api"],
    },

    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let subscriptions = await m.Subscription.findAll({
          where: {
            userId: request.auth.credentials.userId,
            status: "valid",
          },
        })
        reply(subscriptions.map(s => s.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/routes/lite/{routeLabel}/subscription",
    config: {
      auth: { access: { scope: ["user"] } },
      validate: {
        params: Joi.object({
          routeLabel: Joi.string().required(),
        }),
      },
      description: "Creates a subscription to the route for the user",
      tags: ["api"],
    },

    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let route = await m.Route.findOne({
          where: {
            label: request.params.routeLabel,
            tags: { $contains: ["lite"] },
          },
        })
        if (!route) {
          return reply(Boom.badRequest("This is not a lite route"))
        }
        let subscriptionInst = await m.Subscription.findOrCreate({
          where: {
            userId: request.auth.credentials.userId,
            routeLabel: request.params.routeLabel,
          },
          defaults: {
            userId: request.auth.credentials.userId,
            routeLabel: request.params.routeLabel,
            status: "valid",
          },
        })
        // when user unsubscribe it before
        if (subscriptionInst[0].status === "invalid") {
          await subscriptionInst[0].update({
            status: "valid",
          })
        }
        reply(subscriptionInst[0].toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "DELETE",
    path: "/routes/lite/{routeLabel}/subscription",
    config: {
      auth: { access: { scope: ["user"] } },
      validate: {
        params: {
          routeLabel: Joi.string().required(),
        },
      },
      description: "Removes a subscription to the route for the user",
      tags: ["api"],
    },

    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let route = await m.Route.findOne({
          where: {
            label: request.params.routeLabel,
            tags: { $contains: ["lite"] },
          },
        })
        if (!route) {
          return reply(Boom.badRequest("This is not a lite route"))
        }
        let subscription = await m.Subscription.findOne({
          where: {
            userId: request.auth.credentials.userId,
            routeLabel: request.params.routeLabel,
          },
        })
        if (!subscription) {
          return reply(Boom.notFound(request.params.routeLabel))
        }
        await subscription.update({
          status: "invalid",
        })
        reply(subscription.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}

register.attributes = {
  name: "endpoint-lite-routes",
}
