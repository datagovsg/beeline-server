const Boom = require("boom")
import _ from "lodash"
import Joi from "../util/joi"
import { getModels, defaultErrorHandler, SecurityError } from "../util/common"
import { DaysOfWeekSchema } from "../models/Suggestion"
import {
  assertFound,
  handleRequestWith,
  instToJSONOrNotFound,
} from "../util/endpoints"
import { getCompaniesByRole } from "../core/auth"
import { anonymizeEmail } from "../util/email"

/**
 *
 * @param {*} server
 * @param {*} options
 * @param {*} next
 */
export function register(server, options, next) {
  /**
   * Ensures that the instance (if it exists), belongs to the current user
   * @param {Suggestion} instance
   * @param {HAPI.Request} request
   * @param {object} param2
   * @return {Suggestion} instance
   */
  function authorizedToEdit(instance, request, { models }) {
    const isInstanceAuthorized =
      !instance ||
      request.auth.credentials.scope === "superadmin" ||
      (request.auth.credentials.scope === "user" &&
        instance.userId !== request.auth.credentials)

    if (!isInstanceAuthorized) {
      throw new SecurityError("User is not the owner of this suggestion")
    }

    return instance
  }

  /**
   * Returns the suggestion transformed, s.t. the userId matches that of the
   * current user, if scope === 'user'. If scope !== 'user', the original
   * data is returned.
   * @param {*} data
   * @param {*} request
   * @return {object} data, or transformed data
   */
  function ensureUser(data, request) {
    if (request.auth.credentials.scope === "user") {
      return {
        ...data,
        userId: request.auth.credentials.userId,
      }
    } else if (request.auth.credentials.scope === "superadmin") {
      return data
    } else {
      throw new Error("ensureUser() only handles `users` and `superadmins`")
    }
  }

  /**
   * Given a request, returns a mapper function that
   * censors a suggestion's userId and email depending on whether
   * the user is authorized to see them.
   * @param {object} request
   * @return {object}
   */
  async function maskIfUnauthorized(request) {
    const m = getModels(request)

    // Find the list of companies whose customers
    // this admin is authorized to see
    const companyIds = getCompaniesByRole(
      request.auth.credentials,
      "manage-customers"
    )
    // Find the referrers
    const companyReferrers = companyIds
      ? (await m.TransportCompany.findAll({
          where: { id: { $in: companyIds } },
        })).map(c => c.referrer)
      : []

    const isAuthorized = suggestion =>
      request.auth.credentials.scope === "superadmin" ||
      (request.auth.credentials.scope === "admin" &&
        companyReferrers.includes(suggestion.referrer)) ||
      (request.auth.credentials.scope === "user" &&
        suggestion.userId === request.auth.credentials.userId)

    return suggestion =>
      isAuthorized(suggestion)
        ? suggestion.toJSON()
        : {
            ...suggestion.toJSON(),
            userId: null,
            email: anonymizeEmail(suggestion.email),
          }
  }

  server.route({
    method: "GET",
    path: "/suggestions",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.findAll({
          where: {
            userId: request.auth.credentials.userId,
          },
          order: [["id", "DESC"]],
          limit: request.query.limit,
        }),
      s => s.map(t => t.toJSON())
    ),
  })

  server.route({
    method: "GET",
    path: "/all_suggestions",
    config: {
      tags: ["api"],
      validate: {
        query: {
          lastId: Joi.number().optional(),
          limit: Joi.number()
            .integer()
            .default(500)
            .max(500),
        },
      },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.findAll({
          where: {
            ...(request.query.lastId && { id: { $lt: request.query.lastId } }),
          },
          order: [["id", "DESC"]],
          limit: request.query.limit,
        }),
      async (suggestions, request) =>
        suggestions.map(await maskIfUnauthorized(request))
    ),
  })

  server.route({
    method: "GET",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      description: "Get a specific suggestion",
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      (ig, request, { models: { Suggestion } }) =>
        Suggestion.findById(request.params.id),
      assertFound,
      async (suggestion, request) =>
        (await maskIfUnauthorized(request))(suggestion)
    ),
  })

  server.route({
    method: "POST",
    path: "/suggestions",
    config: {
      tags: ["api"],
      validate: {
        payload: Joi.object({
          userId: Joi.number()
            .integer()
            .optional(),

          board: Joi.latlng()
            .latRange([1, 2])
            .lngRange([100, 110])
            .required(),

          alight: Joi.latlng()
            .latRange([1, 2])
            .lngRange([100, 110])
            .required(),

          time: Joi.number()
            .integer()
            .required()
            .min(0)
            .max(24 * 3600e3),

          currentMode: Joi.string().optional(),
          referrer: Joi.string().optional(),
          daysOfWeek: DaysOfWeekSchema,
        }),
      },
      description: `Creates a new suggestion.`,
      auth: { access: { scope: ["user", "superadmin"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.create(ensureUser(request.payload, request)),
      instToJSONOrNotFound
    ),
  })

  server.route({
    method: "PUT",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      validate: {
        payload: Joi.object({
          id: Joi.number()
            .integer()
            .optional(),

          userId: Joi.number()
            .integer()
            .optional(),

          board: Joi.latlng()
            .latRange([1, 2])
            .lngRange([100, 110])
            .required(),

          alight: Joi.latlng()
            .latRange([1, 2])
            .lngRange([100, 110])
            .required(),

          time: Joi.number()
            .integer()
            .required()
            .min(0)
            .max(24 * 3600e3),

          currentMode: Joi.string().optional(),
          daysOfWeek: DaysOfWeekSchema,
        }),
      },
      description: "Updates an existing suggestion",
      auth: { access: { scope: ["user", "superadmin"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.findById(request.params.id),
      assertFound,
      authorizedToEdit,
      (inst, request) =>
        inst
          .update(ensureUser(_.omit(request.payload, ["id"]), request))
          .then(() => inst),
      instToJSONOrNotFound
    ),
  })

  /* Delete */
  server.route({
    method: "DELETE",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
        },
      },
      auth: { access: { scope: ["user", "superadmin"] } },
    },
    handler: handleRequestWith(
      (ig, request, { models }) =>
        models.Suggestion.findById(request.params.id),
      assertFound,
      authorizedToEdit,
      inst => inst.destroy()
    ),
  })

  server.route({
    method: "POST",
    path: "/suggestions/deanonymize",
    config: {
      tags: ["api"],
      description: `Converts all anonymous suggestions made under a particular device uuid
to suggestions under a user`,
      auth: { access: { scope: ["user"] } },
    },
    async handler(request, reply) {
      try {
        const m = getModels(request)
        const user = await m.User.findById(request.auth.credentials.userId)

        if (user.email && user.emailVerified) {
          const [numRowsAffected] = await m.Suggestion.bindEmailToUserId(
            user.email,
            user.id
          )
          reply(numRowsAffected)
        } else {
          reply(Boom.badRequest("User's email is not yet verified"))
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-suggestions",
}
