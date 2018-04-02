import _ from "lodash"
import Joi from "joi"
import assert from "assert"
import * as auth from "../core/auth"
import eventDefinitions from "../events/definitions.js"

import { getModels, defaultErrorHandler } from "../util/common"

const reloadSubscriptions = request => {
  request.server.plugins["daemon-event-subscriptions"] &&
    request.server.plugins["daemon-event-subscriptions"].reloadSubscriptions()
}

export const register = (server, options, next) => {
  server.route({
    method: "GET",
    path: "/companies/{companyId}/eventSubscriptions",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        const m = getModels(request)

        auth.assertAdminRole(
          request.auth.credentials,
          "manage-notifications",
          request.params.companyId
        )

        const subscriptions = await m.EventSubscription.findAll({
          where: {
            transportCompanyId: request.params.companyId,
          },
        })

        reply(subscriptions.map(a => a.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/eventSubscriptions/{id}",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        const m = getModels(request)
        auth.assertAdminRole(
          request.auth.credentials,
          "manage-notifications",
          request.params.companyId
        )
        const subscription = await m.EventSubscription.findOne({
          where: {
            id: request.params.id,
            transportCompanyId: request.params.companyId,
          },
        })

        reply(subscription.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  const validateSubscription = (credentials, companyId, subscription) => {
    // For transactionFailure,
    const definition = eventDefinitions[subscription.event]

    assert(definition)

    subscription.params = subscription.params || {}

    if (definition.authorize) {
      definition.authorize(credentials, companyId, subscription.params)
    }

    if (definition.params) {
      Joi.assert(subscription.params, definition.params)
    }
  }

  server.route({
    method: "PUT",
    path: "/companies/{companyId}/eventSubscriptions/{id}",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
        payload: Joi.object({
          params: Joi.any(),
          event: Joi.string(),
          id: Joi.number().integer(),
          formatter: Joi.string(),
          handler: Joi.string(),
          agent: Joi.object({}).unknown(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        const m = getModels(request)

        auth.assertAdminRole(
          request.auth.credentials,
          "manage-notifications",
          request.params.companyId
        )

        // Check the validity of the request
        // e.g. cannot monitor companies that you are not
        // part of
        validateSubscription(
          request.auth.credentials,
          request.params.companyId,
          request.payload
        )

        // Check ownership
        const subscription = await m.EventSubscription.find({
          where: {
            id: request.params.id,
            transportCompanyId: request.params.companyId,
          },
        })
        // Update
        await subscription.update(
          _.pick(request.payload, [
            "params",
            "event",
            "formatter",
            "handler",
            "agent",
          ])
        )

        reloadSubscriptions(request)

        reply(subscription.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/companies/{companyId}/eventSubscriptions",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          companyId: Joi.number().integer(),
        },
        payload: Joi.object({
          params: Joi.any(),
          event: Joi.string(),
          formatter: Joi.string(),
          handler: Joi.string(),
          agent: Joi.object({}).unknown(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        const m = getModels(request)

        auth.assertAdminRole(
          request.auth.credentials,
          "manage-notifications",
          request.params.companyId
        )
        // Check the validity of the request
        // e.g. cannot monitor companies that you are not
        // part of
        validateSubscription(
          request.auth.credentials,
          request.params.companyId,
          request.payload
        )

        // Update
        const subscription = await m.EventSubscription.create(
          _.defaults(
            {
              transportCompanyId: request.params.companyId,
            },
            request.payload
          )
        )

        reloadSubscriptions(request)

        reply(subscription.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "DELETE",
    path: "/companies/{companyId}/eventSubscriptions/{id}",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        const m = getModels(request)

        auth.assertAdminRole(
          request.auth.credentials,
          "manage-notifications",
          request.params.companyId
        )

        // Check ownership
        const subscription = await m.EventSubscription.findById(
          request.params.id
        )

        await subscription.destroy()

        reloadSubscriptions(request)

        reply("")
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })
  next()
}

register.attributes = {
  name: "endpoint-event-subscriptions",
}
