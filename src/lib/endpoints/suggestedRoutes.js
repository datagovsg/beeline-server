import Joi from "../util/joi"
import { SecurityError } from "../util/common"
import { handleRequestWith, instToJSONOrNotFound } from "../util/endpoints"
import { routeSchema } from "../models/SuggestedRoute"

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
    async handler() {
      // FIXME: @Azima!
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-suggested-routes",
}
