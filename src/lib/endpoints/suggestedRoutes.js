import _ from "lodash"
import Joi from "../util/joi"
import subzones from "ura-subzones"
import {
  SecurityError,
  defaultErrorHandler,
  getModels,
  getDB,
} from "../util/common"
import { handleRequestWith, instToJSONOrNotFound } from "../util/endpoints"
import { TransactionError } from "../util/errors"
import { routeSchema } from "../models/SuggestedRoute"

const DEFAULT_CROWDSTART_PRICE = 5.0
const DEFAULT_CROWDSTART_VALIDITY = 30 // 30 days from now
const DEFAULT_CROWDSTART_START = 15 // 15 days from now
const DEFAULT_CROWDSTART_CAPACITY = 13

/**
 * Same scheme as the above, except this one actually creates the model in question
 * and returns the resulting instance
 * @param {Object} defaultOptions - Sequelize options for object creation
 * @return {Function} a function that creates a Promise to build a Sequelize object
 */
function _createModelCreate(defaultOptions) {
  const modelCreate = (model, data, options) =>
    model.create(data, { ...defaultOptions, ...options })
  return modelCreate
}

const ensureUserHasCreditCard = async function ensureUserHasCreditCard(user) {
  TransactionError.assert(
    _.get(user, "savedPaymentInfo.sources.data.length", 0) >= 1,
    "You need to have at least one saved payment method to create a crowdstart route"
  )
}

const createCrowdstartRouteDetails = async function createCrowdstartRouteDetails(
  suggestion,
  suggestedRoute,
  { model, createFunc, transaction }
) {
  // FIXME: assuming the stops are sorted in route order
  const from = suggestedRoute[0]
  const dropOffIndex = suggestedRoute.length - 1
  const to = suggestedRoute[dropOffIndex]

  const fromStop = subzones.getSubzoneAtPoint([from.lat, from.lng]).properties
    .nice_name
  const toStop = subzones.getSubzoneAtPoint([to.lat, to.lng]).properties
    .nice_name

  const route = await createFunc(model.Route, {
    name: `${fromStop} to ${toStop}`,
    from: fromStop,
    to: toStop,
    path: suggestedRoute.map(({ lat, lng }) => [lat, lng]),
    transportCompanyId: null,
    label: "AUTO-" + Date.now(),
    schedule: "Mon - Fri", // FIXME: this should be derived from daysOfWeek in Suggestion
    tags: ["crowdstart", "autogenerated", "tentative"],
    notes: {
      signage: "??",
      noPasses: 15,
      crowdstartExpiry: new Date(
        Date.now() + DEFAULT_CROWDSTART_VALIDITY * 24 * 3600e3
      ).toISOString(),
      tier: [{ pax: 15, price: DEFAULT_CROWDSTART_PRICE }],
    },
    features: `
- This route is currently **tentative**. Travel time, price and start date is
subject to change
- Expiry of the crowdstart may be extended if there are more people joining
the campaign.
    `,
  })

  // create Trip
  await createFunc(
    model.Trip,
    {
      date: new Date(Date.now() + DEFAULT_CROWDSTART_START * 24 * 3600e3), // FIXME: should it be added by DEFAULT_CROWDSTART_START here
      capacity: DEFAULT_CROWDSTART_CAPACITY,
      price: DEFAULT_CROWDSTART_PRICE * 10,
      status: null,
      routeId: route.id,
      bookingInfo: {
        windowType: "stop",
        windowSize: -5 * 60e3,
      },
      tripStops: suggestedRoute.map(({ stopId, time }, index) => ({
        stopId,
        canBoard: index < dropOffIndex,
        canAlight: index >= dropOffIndex,
        time: new Date(time),
      })),
    },
    { include: [{ model: model.TripStop }] }
  )

  return route
}

/**
 *
 * @param {*} server
 * @param {*} options
 * @param {*} next
 */
export function register(server, options, next) {
  /**
   * Ensures that the suggestion belongs to the user
   * @param {Suggestion} suggestion
   * @param {HAPI.Request} request
   * @param {object} param2
   * @return {Suggestion} instance
   */
  function authorizedToEdit(suggestion, request, { models }) {
    const isInstanceAuthorized = request.auth.credentials.scope === "superadmin"

    if (!isInstanceAuthorized) {
      throw new SecurityError("Only superadmins may modify suggested routes")
    }

    return suggestion
  }

  server.route({
    method: "GET",
    path: "/suggestions/{suggestionId}/suggested_routes",
    config: {
      tags: ["api"],
      validate: {
        params: {
          suggestionId: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.SuggestedRoute.findAll({
          where: {
            seedSuggestionId: request.params.suggestionId,
          },
          order: [["id", "DESC"]],
        }),
      suggestedRoutes => suggestedRoutes.map(s => s.toJSON())
    ),
  })

  server.route({
    method: "GET",
    path: "/suggestions/{suggestionId}/suggested_routes/{id}",
    config: {
      tags: ["api"],
      validate: {
        params: {
          suggestionId: Joi.number().integer(),
          id: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.SuggestedRoute.find({
          where: {
            id: request.params.id,
            seedSuggestionId: request.params.suggestionId,
          },
          order: [["id", "DESC"]],
        }),
      instToJSONOrNotFound
    ),
  })

  server.route({
    method: "DELETE",
    path: "/suggestions/{suggestionId}/suggested_routes/{id}",
    config: {
      tags: ["api"],
      validate: {
        params: {
          suggestionId: Joi.number().integer(),
          id: Joi.number().integer(),
        },
      },
      auth: { access: { scope: ["superadmin"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.findById(request.params.suggestionId),
      authorizedToEdit,
      (ig, request, { models }) =>
        models.SuggestedRoute.destroy({
          where: {
            id: request.params.id,
            seedSuggestionId: request.params.suggestionId,
          },
          order: [["id", "DESC"]],
        }),
      () => ""
    ),
  })

  server.route({
    method: "POST",
    path: "/suggestions/{suggestionId}/suggested_routes",
    config: {
      tags: ["api"],
      validate: {
        params: {
          suggestionId: Joi.number().integer(),
        },
        payload: {
          route: routeSchema,
        },
      },
      description: `Create a new suggested routes`,
      auth: { access: { scope: ["superadmin"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.SuggestedRoute.create({
          ...request.payload,
          seedSuggestionId: request.params.suggestionId,
          userId: null /* Not created by a user */,
          adminEmail: request.auth.credentials.email,
        }),
      s => s.toJSON()
    ),
  })

  server.route({
    method: "POST",
    path:
      "/suggestions/{suggestionId}/suggested_routes/{id}/convert_to_crowdstart",
    config: {
      tags: ["api"],
      validate: {
        params: {
          suggestionId: Joi.number().integer(),
          id: Joi.number().integer(),
        },
      },
      description: `Create a new suggested routes`,
      auth: { access: { scope: ["user"] } },
    },
    async handler(request, reply) {
      const createCrowdstartRouteAndBid = async function createCrowdstartRouteAndBid(
        { m, db },
        { user, suggestion, suggestedRoute }
      ) {
        return db.transaction(async transaction => {
          // create crowdstart route details from suggested route
          // create route, trip and stops
          const route = createCrowdstartRouteDetails(
            suggestion,
            suggestedRoute,
            {
              m,
              createFunc: _createModelCreate({ transaction }),
              transaction,
            }
          )

          // create bid
          return m.Bid.createForUserAndRoute(
            user,
            route,
            DEFAULT_CROWDSTART_PRICE,
            { transaction }
          )
        })
      }

      try {
        let m = getModels(request)
        let db = getDB(request)
        const user = await m.User.findById(request.auth.credentials.userId)

        // check user has credit card
        await ensureUserHasCreditCard(user)

        // Get suggestion and suggested route
        const suggestion = await m.Suggestion.findById(
          request.params.suggestionId
        )
        const suggestedRoute = await m.SuggestedRoute.find({
          where: {
            id: request.params.id,
            seedSuggestionId: request.params.suggestionId,
          },
          order: [["id", "DESC"]],
        })

        const newBid = await createCrowdstartRouteAndBid(
          { m, db },
          { user, suggestion, suggestedRoute }
        )

        reply({
          bid: newBid.toJSON(),
          route: (await m.Route.findById(newBid.routeId, {
            include: [
              {
                model: m.Trip,
                include: [{ model: m.TripStop, include: [m.Stop] }],
              },
            ],
          })).toJSON(),
        })
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-suggested-routes",
}
