import _ from "lodash"
import Joi from "joi"
import * as auth from '../core/auth'
import {getModels, getDB, defaultErrorHandler, NotFoundError,
        TransactionError} from "../util/common"
import {TransactionBuilder} from "../transactions/builder"
import {handleRequestWith, authorizeByRole} from "../util/endpoints"

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/routeCredits",
    config: {
      tags: ["api"],
      description: "Get current user's route credits in JSON with key value pair ksTag: balance",
      auth: {access: {scope: ['user']}},
    },

    handler: async function (request, reply) {
      var m = getModels(request)

      try {
        let routeCredits = await m.RouteCredit.findAll({
          where: {
            userId: request.auth.credentials.userId,
          },
          attributes: ['tag', 'balance', 'companyId']
        })

        reply(
          _(routeCredits)
            .map(rc => [rc.tag, rc.balance])
            .fromPairs()
            .value()
        )
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/routeCreditsByUser/{userId}",
    config: {
      tags: ["api"],
      description: "Get route credits for a specified user",
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          userId: Joi.number().integer().min(0).required(),
          companyId: Joi.number().integer().min(0).required()
        }
      }
    },

    handler: async function (request, reply) {
      var m = getModels(request)

      const { userId, companyId } = request.params

      try {
        // limit to tags related to company if queried by admin
        if (request.auth.credentials.scope === 'admin') {
          auth.assertAdminRole(request.auth.credentials, 'manage-routes', companyId)
        }

        let userInst = await m.User.findById(userId)
        NotFoundError.assert(userInst)

        let routeCredits = await m.RouteCredit.findAll({
          where: { userId, companyId },
        })

        reply(routeCredits)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "POST",
    path: "/companies/{companyId}/route_credits/{creditTag}/users/{userId}/expire",
    config: {
      tags: ["api"],
      description: "Expire a certain number of credits for a particular user",
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          creditTag: Joi.string().required(),
          companyId: Joi.number().integer().min(0).required(),
          userId: Joi.number().integer().required(),
        },
        payload: {
          amount: Joi.number().precision(2).positive().required(),
        }
      }
    },

    handler: async function (request, reply) {
      try {
        const m = getModels(request)
        const db = getDB(request)

        const {companyId, creditTag} = request.params
        const userId = request.params.userId

        // limit to tags related to company if queried by admin
        auth.assertAdminRole(request.auth.credentials, 'manage-routes', companyId)

        // Create the transaction
        const [expireTransaction] = await db.transaction({
          isolationLevel: db.Transaction.ISOLATION_LEVELS.SERIALIZABLE
        }, async (transaction) => {
          let userInst = await m.User.findById(userId, {transaction})
          NotFoundError.assert(userInst, `User ${userId} not found`)

          let routeCredits = await m.RouteCredit.find({
            where: { userId, companyId, tag: creditTag },
            transaction,
          })

          if (routeCredits.balance < request.payload.amount) {
            throw new TransactionError(`User ${userId} has fewer credits than is being expired`)
          }

          let transactionBuilder = new TransactionBuilder({
            db, models: m, transaction, dryRun: false,
            committed: true,
            creator: {
              type: request.auth.credentials.scope,
              id: request.auth.credentials.adminId || request.auth.credentials.email
            },
          })

          transactionBuilder.transactionItemsByType.routeCredits = [{
            itemType: 'routeCredits',
            itemId: routeCredits.id,
            debit: request.payload.amount,
          }]

          transactionBuilder.transactionItemsByType.account = [{
            itemType: 'account',
            itemId: (await m.Account.getByName('Upstream Route Credits', {attributes: ['id']})).id,
            credit: request.payload.amount
          }]

          const oldBalance = routeCredits.balance
          const newBalance = parseFloat(routeCredits.balance) - request.payload.amount
          transactionBuilder.description = `Manually expire route credits in ${routeCredits.id} from [${oldBalance}] to [${newBalance}]`

          // Side effect -- update the credits
          routeCredits.balance = newBalance
          await routeCredits.save({transaction})

          // Build the transaction
          return transactionBuilder.build({type: 'routeCreditExpiry'})
        })

        reply(expireTransaction)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_credits/{creditTag}/users/{userId}/history",
    config: {
      tags: ["api"],
      description: `Returns a list of the user's past route credit transactions.
        There is a limit of 20 transactions. To query more, pass the last (i.e. smallest) id of
        the previous set of transaction items to the subsequent query.
        `,
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          creditTag: Joi.string().required(),
          companyId: Joi.number().integer().min(0).required(),
          userId: Joi.number().integer().required(),
        },
        query: {
          lastId: Joi.number().integer().allow(null),
        }
      }
    },

    handler: async function (request, reply) {
      try {
        const m = getModels(request)

        const {companyId, creditTag, userId} = request.params

        // limit to tags related to company if queried by admin
        auth.assertAdminRole(request.auth.credentials, 'manage-routes', companyId)

        let routeCredits = await m.RouteCredit.find({
          where: { userId, companyId, tag: creditTag },
        })

        // Create the transaction
        const transactionItems = await m.TransactionItem.findAll({
          where: {
            itemType: 'routeCredits',
            itemId: routeCredits.id,
            ...(request.query.lastId ? {id: {$lt: request.query.lastId}} : {})
          },
          limit: 20,
          order: [['id', 'DESC']],
          include: [{
            model: m.Transaction,
            where: {committed: true}
          }]
        })

        reply(transactionItems.map(t => t.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_credits/{creditTag}/users",
    config: {
      tags: ["api"],
      description: `
      Returns a list of entries bearing user names and balances for a given
      company's credit tag with positive balance of credits
      `,
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          creditTag: Joi.string().required(),
          companyId: Joi.number().integer().min(0).required(),
        },
      }
    },

    handler: handleRequestWith(
      authorizeByRole('manage-routes', request => request.params.companyId),
      request => getModels(request).RouteCredit.findAll({
        where: {
          companyId: request.params.companyId,
          tag: request.params.creditTag,
          balance: {$gt: 0}
        },
        raw: true
      })
    )
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_credits",
    config: {
      tags: ["api"],
      description: `
      Returns for a given company a list of credit tags where there is
      at least one entry with positive balance of credits
      `,
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          companyId: Joi.number().integer().min(0).required(),
        },
      }
    },

    handler: handleRequestWith(
      authorizeByRole('manage-routes', request => request.params.companyId),
      request => getDB(request).query(
        `SELECT DISTINCT tag FROM "routeCredits"
        WHERE "companyId" = :companyId and balance > 0`,
        {
          replacements: {
            companyId: request.params.companyId,
          },
          raw: true,
          type: getDB(request).QueryTypes.SELECT
        }
      ),
      tagObjects => tagObjects.map(t => t.tag)
    )
  })

  next()
}

register.attributes = {
  name: "endpoint-route-credits"
}
