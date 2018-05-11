import _ from "lodash"
import Joi from "joi"
import assert from "assert"
import moment from "moment"
import { InvalidArgumentError } from "../util/common"
import {
  handleRequestWith,
  authorizeByRole,
  assertFound,
  inSingleDBTransaction,
} from "../util/endpoints"
import { TransactionBuilder } from "../transactions/builder"

export const register = function register(server, options, next) {
  const fetchValidRoutePassesThen = transform =>
    handleRequestWith(
      (ignored, request, { models }) =>
        models.RoutePass.findAll({
          where: {
            userId: request.auth.credentials.userId,
            status: "valid",
          },
        }),
      routePasses => routePasses.map(r => r.toJSON()),
      transform
    )

  server.route({
    method: "GET",
    path: "/route_passes",
    config: {
      tags: ["api"],
      description: "Get current user's route passes in JSON, keyed by tag",
      auth: { access: { scope: ["user"] } },
    },
    handler: fetchValidRoutePassesThen(routePasses =>
      _.countBy(routePasses, "tag")
    ),
  })

  server.route({
    method: "GET",
    path: "/route_passes/expiries",
    config: {
      tags: ["api"],
      description:
        "Get current user's route passes in JSON, keyed by tag and expiry date",
      auth: { access: { scope: ["user"] } },
    },
    handler: fetchValidRoutePassesThen(routePasses =>
      _(routePasses)
        .groupBy("tag")
        .mapValues(routePasses =>
          _(routePasses)
            .countBy("expiresAt")
            .mapKeys(date => moment(new Date(date)).format("YYYY-MM-DD"))
            .value()
        )
        .value()
    ),
  })

  const authorizeRouteManager = authorizeByRole(
    "manage-routes",
    (p, r) => r.params.companyId
  )

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_passes/{tag}/users/{userId}",
    config: {
      tags: ["api"],
      description: "Get valid route passes for a specified user and tag",
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          userId: Joi.number()
            .integer()
            .min(0)
            .required(),
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
          tag: Joi.string().description(
            'The route tag, or "all" for all route tags'
          ),
        },
      },
    },

    handler: handleRequestWith(
      authorizeRouteManager,
      (ignored, request) => {
        const { userId, companyId, tag } = request.params
        return tag === "all"
          ? { userId, companyId, tag: null }
          : { userId, companyId, tag }
      },
      (replacements, request, { db }) =>
        db.query(
          `
        SELECT DISTINCT ON (tag, "companyId", "userId")
          tag,
          "companyId",
          "userId",
          (
            SELECT count(*)::integer
            FROM "routePasses" rp2
            WHERE
            rp2.status='valid' AND
            rp2.tag = rp1.tag AND
            rp2."userId" = rp1."userId" AND
            rp2."companyId" = rp1."companyId"
          ) AS balance
        FROM
          "routePasses" rp1
        WHERE
          "userId" = :userId AND
          "companyId" = :companyId AND
          (tag = :tag OR :tag IS NULL)
        GROUP BY tag, "companyId", "userId"
        `,
          {
            type: db.QueryTypes.SELECT,
            replacements,
          }
        )
    ),
  })

  const expireRoutePass = async (
    routePassInst,
    { auth, params },
    { db, models, transaction }
  ) => {
    InvalidArgumentError.assert(
      params.companyId === routePassInst.companyId &&
        params.userId === routePassInst.userId &&
        params.tag === routePassInst.tag,
      "Route pass details do not line up with request parameters"
    )
    InvalidArgumentError.assert(
      routePassInst.status === "valid",
      `Only valid route passes can be expired. This route pass is [${
        routePassInst.status
      }]`
    )
    const routePassPurchaseTransactionItem = await models.TransactionItem.find({
      where: {
        itemType: "routePass",
        itemId: routePassInst.id,
        debit: { $lt: 0 },
      },
      transaction,
    })
    const price = routePassPurchaseTransactionItem.creditF
    assert(
      price,
      "Unable to find price that route pass was bought at. This is needed for accounting purposes."
    )
    const expiryAccount = await models.Account.getByName(
      "Upstream Route Credits",
      {
        transaction,
      }
    )
    const tb = new TransactionBuilder({
      db,
      models,
      transaction,
      committed: true,
      dryRun: false,
      creator: { type: auth.credentials.scope, id: auth.credentials.userId },
    })

    tb.transactionItemsByType = {
      routePass: [
        {
          itemType: "routePass",
          itemId: routePassInst.id,
          debit: price,
          notes: {},
        },
      ],
      account: [
        {
          itemType: "account",
          itemId: expiryAccount.id,
          debit: -price,
        },
      ],
    }
    await tb.build({ type: "routePassExpiry" })
    return routePassInst.update({ status: "expired" }, { transaction })
  }

  server.route({
    method: "POST",
    path: "/companies/{companyId}/route_passes/{tag}/users/{userId}/expire",
    config: {
      tags: ["api"],
      description:
        "Expire a number of route passes, choosing the oldest ones first",
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          tag: Joi.string().required(),
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
          userId: Joi.number()
            .integer()
            .min(0)
            .required(),
        },
        payload: {
          quantity: Joi.number()
            .integer()
            .min(1)
            .required(),
        },
      },
    },

    handler: handleRequestWith(
      authorizeRouteManager,
      inSingleDBTransaction(
        (ignored, { payload, params }, { models, transaction }) =>
          models.RoutePass.findAll({
            where: { ...params, status: "valid" },
            limit: payload.quantity,
            order: "id",
            transaction,
          }),
        (routePassInsts, request, context) =>
          Promise.all(
            routePassInsts.map(r => expireRoutePass(r, request, context))
          )
      )
    ),
  })

  server.route({
    method: "POST",
    path:
      "/companies/{companyId}/route_passes/{tag}/users/{userId}/{routePassId}/expire",
    config: {
      tags: ["api"],
      description: "Expire a route pass",
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          tag: Joi.string().required(),
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
          userId: Joi.number()
            .integer()
            .min(0)
            .required(),
          routePassId: Joi.number()
            .integer()
            .min(0)
            .required(),
        },
      },
    },

    handler: handleRequestWith(
      authorizeRouteManager,
      inSingleDBTransaction(
        (ignored, { params }, { models, transaction }) =>
          models.RoutePass.findById(params.routePassId, { transaction }),
        assertFound,
        expireRoutePass
      )
    ),
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_passes/{tag}/users/{userId}/history",
    config: {
      tags: ["api"],
      description: `Returns a list of the user's past route pass transactions.
        There is a limit of 20 transactions. To query more, pass the last (i.e. smallest) id of
        the previous set of transaction items to the subsequent query.
        `,
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          tag: Joi.string().required(),
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
          userId: Joi.number()
            .integer()
            .required(),
        },
        query: {
          lastId: Joi.number()
            .integer()
            .allow(null),
        },
      },
    },
    handler: handleRequestWith(
      authorizeRouteManager,
      (ignored, request) => request.params,
      ({ companyId, tag, userId }, request, { models }) =>
        models.TransactionItem.findAll({
          where: {
            itemType: "routePass",
            ...(request.query.lastId
              ? { id: { $lt: request.query.lastId } }
              : {}),
          },
          limit: 20,
          order: [["id", "DESC"]],
          include: [
            { model: models.Transaction, where: { committed: true } },
            {
              model: models.RoutePass,
              as: "routePass",
              where: { companyId, tag, userId },
              attributes: ["id"],
            },
          ],
        }),
      transactionItems => transactionItems.map(t => t.toJSON())
    ),
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_passes/{tag}/users",
    config: {
      tags: ["api"],
      description: `
      Returns a list of entries bearing user ids and number of
      valid route passes for a given company's tag
      `,
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          tag: Joi.string().required(),
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
        },
      },
    },

    handler: handleRequestWith(
      authorizeRouteManager,
      (ignored, request, { models }) =>
        models.RoutePass.findAll({
          where: {
            companyId: request.params.companyId,
            tag: request.params.tag,
            status: "valid",
          },
        }),
      routePassInsts => routePassInsts.map(r => r.toJSON()),
      routePasses => _.groupBy(routePasses, "userId")
    ),
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/route_passes",
    config: {
      tags: ["api"],
      description: `
      Returns for a given company a list of tags where there is
      at least one valid route pass
      `,
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          companyId: Joi.number()
            .integer()
            .min(0)
            .required(),
        },
      },
    },

    handler: handleRequestWith(
      authorizeRouteManager,
      (ignored, request, { db }) =>
        db.query(
          `SELECT DISTINCT tag FROM "routePasses"
        WHERE "companyId" = :companyId and status = 'valid'`,
          {
            replacements: {
              companyId: request.params.companyId,
            },
            raw: true,
            type: db.QueryTypes.SELECT,
          }
        ),
      tagObjects => tagObjects.map(t => t.tag)
    ),
  })

  next()
}

register.attributes = {
  name: "endpoint-route-passes",
}
