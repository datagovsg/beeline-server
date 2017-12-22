const Joi = require("joi")
import assert from "assert"
import {getModels, defaultErrorHandler} from '../util/common'
import {SecurityError, TransactionError} from '../util/errors'
import {stripe} from '../transactions/payment'

/**
**/
export function register (server, options, next) {
  server.route({
    method: "POST",
    path: "/users/{userId}/creditCards",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          userId: Joi.number().integer(),
        },
        payload: {
          stripeToken: Joi.string().required(),
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        SecurityError.assert.strictEqual(request.params.userId, request.auth.credentials.userId)

        var userInst = await m.User.findById(request.params.userId)

        try {
          const newCustomerInfo = await userInst.addPaymentSource(request.payload.stripeToken)
          await userInst.save()
          reply(newCustomerInfo)
        } catch (err) {
          // try to re-sync payment source info if above calls have errors
          await userInst.refreshPaymentInfo()
          await userInst.save()
          throw err
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })
  server.route({
    method: "DELETE",
    path: "/users/{userId}/creditCards/{sourceId}",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          userId: Joi.number().integer(),
          sourceId: Joi.string(),
        },
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        SecurityError.assert.strictEqual(request.params.userId, request.auth.credentials.userId)

        var userInst = await m.User.findById(request.params.userId)

        // Check if there's already customer info
        var customerInfo = userInst.savedPaymentInfo

        assert(customerInfo)

        // Don't allow deletion if user has only one source
        if (userInst.savedPaymentInfo.sources.data.length === 1) {
          // Ensure user has not committed to a crowdstart bid that is still live
          let bids = await m.Bid.findAll({
            where: {status: 'bidded', userId: request.params.userId}
          })

          TransactionError.assert(bids.length === 0,
            "Payment information cannot be deleted becuase you " +
            "have open bids.")
        }

        try {
          // Delete the card...
          await stripe.customers.deleteCard(customerInfo.id, request.params.sourceId)

          // Return the result
          var newCustomerInfo = await stripe.customers.retrieve(customerInfo.id)

          userInst.savedPaymentInfo = newCustomerInfo
          await userInst.save()

          reply(newCustomerInfo)
        } catch (err) {
          // try to re-sync payment source info if above calls have errors
          await userInst.refreshPaymentInfo()
          await userInst.save()
          throw (err)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })
  server.route({
    method: "GET",
    path: "/users/{userId}/creditCards",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          userId: Joi.number().integer(),
        },
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        SecurityError.assert.strictEqual(request.params.userId, request.auth.credentials.userId)

        var userInst = await m.User.findById(request.params.userId)

        reply(userInst.savedPaymentInfo)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "POST",
    path: "/users/{userId}/creditCards/replace",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          userId: Joi.number().integer(),
        },
        payload: {
          stripeToken: Joi.string().required(),
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        SecurityError.assert.strictEqual(request.params.userId, request.auth.credentials.userId)

        const userInst = await m.User.findById(request.params.userId)

        // Check if there's customer info
        var customerInfo = userInst.savedPaymentInfo

        assert(customerInfo)

        var currentSourceId
        if (customerInfo.sources && customerInfo.sources.data && customerInfo.sources.data.length > 0) {
          currentSourceId = customerInfo.sources.data[0].id
        }
        try {
          await stripe.customers.createSource(customerInfo.id, {
            source: request.payload.stripeToken
          })
          if (currentSourceId) {
            await stripe.customers.deleteCard(customerInfo.id, currentSourceId)
          }

          var newCustomerInfo = await stripe.customers.retrieve(customerInfo.id)
          userInst.savedPaymentInfo = newCustomerInfo
          await userInst.save()
          reply(newCustomerInfo)
        } catch (error) {
          // re-sync user save payment infor if there is error
          await userInst.refreshPaymentInfo()
          await userInst.save()
          throw error
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })
  next()
}
register.attributes = {
  name: "endpoint-user-payment-info"
}
