import _ from "lodash"
import Joi from "joi"
import assert from "assert"

import * as auth from "../core/auth"
import {
  instToJSONOrNotFound,
  assertFound,
  routeRequestsTo,
  handleRequestWith,
  inSingleDBTransaction,
} from "../util/endpoints"
import { chargeSale, purchaseRoutePass } from "../transactions"
import {
  InvalidArgumentError,
  TransactionError,
  ChargeError,
} from "../util/errors"
import { getModels, getDB, defaultErrorHandler } from "../util/common"
import { emit } from "../events/events"

export const register = function(server, options, next) {
  const mapToRoots = path => ["/crowdstart" + path]

  routeRequestsTo(server, mapToRoots("/status"), {
    method: "GET",
    config: {
      tags: ["api"],
      validate: {
        query: {
          transportCompanyId: Joi.number()
            .integer()
            .optional(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        let crowdstartQuery = {
          where: {
            tags: { $contains: ["crowdstart"] },
          },
          include: [
            {
              model: m.Trip,
              include: [
                {
                  model: m.TripStop,
                  include: [m.Stop],
                },
              ],
              // performance optimization
              separate: true,
            },
          ],
          attributes: {
            exclude: ["path"],
          },
        }
        if (request.query.transportCompanyId) {
          crowdstartQuery.where.transportCompanyId =
            request.query.transportCompanyId
        }
        let routes = await m.Route.findAll(crowdstartQuery)

        routes = routes.map(r => r.toJSON())

        if (routes.length > 0) {
          let bids = await m.Bid.findAll({
            where: {
              routeId: { $in: routes.map(r => r.id) },
              status: { $in: ["bidded", "failed", "void"] },
            },
          })
          bids = _(bids)
            .map(bid => bid.toJSON())
            .groupBy("routeId")
            .value()

          // match the discount to the route
          for (let route of routes) {
            route.bids = bids[route.id] || []
          }
        }
        const completionProgress = route => {
          const bidCount = (route.bids || []).filter(
            bid => bid.status === "bidded"
          ).length

          const paxNeeded = _.get(route, "notes.tier[0].pax")
          return paxNeeded ? -(bidCount / paxNeeded) : 0
        }
        reply(
          _(routes)
            .sortBy(completionProgress)
            .value()
        )
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  const findCrowdstartRouteAndAssertAdminRole = async function(
    request,
    transaction
  ) {
    const models = getModels(request)
    const route = await models.Route.findById(request.params.routeId, {
      include: [
        {
          model: models.Trip,
          where: { status: null },
          separate: true,
          include: [{ model: models.TripStop }],
        },
      ],
      transaction,
    })
    assertFound(route)
    auth.assertAdminRole(
      request.auth.credentials,
      "manage-routes",
      route.transportCompanyId
    )
    TransactionError.assert(
      route.tags.includes("crowdstart"),
      "Selected route is not a crowdstart route"
    )
    TransactionError.assert(
      !route.tags.includes("failed") && !route.tags.includes("success"),
      "Route has been failed or activated already"
    )
    return route
  }

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/activate"), {
    method: "POST",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      description: `
Activates a crowdstart route with the specified trip price, tagging it with the 'success' tag and
creating a copy of the route tagged as 'public' and 'crowdstart-{routeId}'
      `,
      validate: {
        payload: {
          price: Joi.number().required(),
          label: Joi.string().required(),
        },
      },
    },
    handler: handleRequestWith(
      inSingleDBTransaction(
        async (ignored, request, { models, transaction }) => {
          const route = await findCrowdstartRouteAndAssertAdminRole(
            request,
            transaction
          )

          const omissions = ["id", "createdAt", "updatedAt"]
          const oldTrip = route.trips[0]
          const newTrip = {
            ..._.omit(oldTrip.toJSON(), omissions),
            seatsAvailable: oldTrip.capacity,
            tripStops: oldTrip.tripStops.map(ts =>
              _.omit(ts.toJSON(), omissions.concat("tripId"))
            ),
            price: request.payload.price,
          }
          const newRoute = {
            ..._.omit(route.toJSON(), omissions),
            label: request.payload.label,
            notes: _.pick(route.notes, "signage"),
            trips: [newTrip],
            tags: ["public"],
          }

          const publicRouteInst = await models.Route.create(newRoute, {
            include: [
              {
                model: models.Trip,
                include: [models.TripStop],
              },
            ],
            transaction,
          })

          await publicRouteInst.update(
            {
              tags: publicRouteInst.tags.concat(
                "crowdstart-" + publicRouteInst.id
              ),
            },
            { transaction }
          )

          await route.update(
            {
              tags: route.tags.concat(["success"]),
              notes: _.assign({}, route.notes, {
                activatedRouteId: publicRouteInst.id,
              }),
            },
            { transaction }
          )

          return publicRouteInst.toJSON()
        }
      )
    ),
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/expire"), {
    method: "POST",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      description: `
Expires a crowdstart route, tagging it with the 'failed' tag and
marking all bids on this route as 'failed'
      `,
    },
    handler: handleRequestWith(
      inSingleDBTransaction(
        (ignored, request, { transaction }) =>
          findCrowdstartRouteAndAssertAdminRole(request, transaction),
        (route, request, { transaction }) =>
          route.update(
            { tags: route.tags.concat(["failed"]) },
            { transaction }
          ),
        async (route, request, { models, transaction }) => {
          await models.Bid.update(
            { status: "failed" },
            { where: { routeId: route.id, status: "bidded" }, transaction }
          )
          return route
        },
        instToJSONOrNotFound
      )
    ),
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/bids"), {
    method: "POST",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      description: "Posts a crowdstart bid from the user for a route",
      validate: {
        payload: {
          price: Joi.number().required(),
        },
      },
    },
    async handler(request, reply) {
      let m = getModels(request)

      try {
        const userInst = await m.User.findById(request.auth.credentials.userId)
        const routeInst = await m.Route.findById(request.params.routeId)

        const bidInst = await m.Bid.createForUserAndRoute(
          userInst,
          routeInst,
          request.payload.price
        )

        emit("crowdstart", { label: routeInst.label })
        reply(bidInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/bids/update_price"), {
    method: "POST",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      description: "update existing crowdstart bid price",
      validate: {
        payload: {
          price: Joi.number().required(),
        },
      },
    },
    handler: handleRequestWith(
      (r, request) => getModels(request).Route.findById(request.params.routeId),
      assertFound,
      (route, request) =>
        auth.assertAdminRole(
          request.auth.credentials,
          "manage-routes",
          route.transportCompanyId
        ),
      (r, request) =>
        getModels(request).Bid.findAll({
          where: {
            routeId: request.params.routeId,
            status: "bidded",
          },
        }),
      (existingBids, request) =>
        existingBids.map(bid =>
          bid.update({ price: request.payload.price }).toJSON()
        )
    ),
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/bids"), {
    method: "GET",
    config: {
      validate: {
        query: {
          statuses: Joi.array()
            .items(
              Joi.string().valid([
                "void",
                "withdrawn",
                "failed",
                "pending",
                "bidded",
              ])
            )
            .default(["void", "withdrawn", "failed", "pending", "bidded"]),
        },
      },
      auth: {
        access: { scope: ["public", "user", "admin", "superadmin"] },
      },
      tags: ["api"],
      description: `Returns all bids made for a given route`,
    },
    handler: handleRequestWith(
      request => getModels(request).Route.findById(request.params.routeId),
      async (route, request) => {
        if (!["public", "user"].includes(request.auth.credentials.scope)) {
          await auth.assertAdminRole(
            request.auth.credentials,
            "manage-routes",
            route.transportCompanyId
          )
        }
        return route
      },
      (route, request) => {
        const m = getModels(request)
        const params = {
          where: { routeId: route.id },
        }
        if (["public", "user"].includes(request.auth.credentials.scope)) {
          params.include = [
            {
              model: m.User,
              attributes: ["name", "email", "telephone"],
            },
          ]
        } else {
          params.where.status = { $in: ["bidded", "failed", "void"] }
        }
        return m.Bid.findAll(params)
      },
      bids => bids.map(bid => bid.toJSON())
    ),
  })

  routeRequestsTo(server, mapToRoots("/bids"), {
    method: "GET",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      description: `Returns a list of the logged-in user's bids`,
    },
    handler: handleRequestWith(
      request =>
        getModels(request).Bid.findAll({
          where: {
            userId: request.auth.credentials.userId,
            status: { $in: ["bidded", "failed", "void"] },
          },
        }),
      bids => bids.map(bid => bid.toJSON())
    ),
  })

  routeRequestsTo(server, mapToRoots("/users/{userId}/bids"), {
    method: "GET",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      description: `Returns a list of a user's bids`,
    },
    handler: handleRequestWith(
      request =>
        getModels(request).Bid.findAll({
          where: {
            userId: request.params.userId,
          },
          include: [
            {
              model: getModels(request).Route,
              where: {
                transportCompanyId: {
                  $in: auth.getCompaniesByRole(
                    request.auth.credentials,
                    "view-passengers"
                  ),
                },
              },
              attributes: [],
            },
          ],
        }),
      bids => bids.map(bid => bid.toJSON())
    ),
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/bids"), {
    method: "DELETE",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      description: `Withdraws the logged in user's bid for this route`,
      validate: {
        params: {
          routeId: Joi.number()
            .integer()
            .required(),
        },
      },
    },
    handler: handleRequestWith(
      request =>
        getModels(request).Bid.findOne({
          where: {
            routeId: request.params.routeId,
            userId: request.auth.credentials.userId,
            status: "bidded",
          },
        }),
      assertFound,
      existingBid => existingBid.update({ status: "withdrawn" }),
      instToJSONOrNotFound
    ),
  })

  routeRequestsTo(server, mapToRoots("/routes/{routeId}/bids/{bidId}"), {
    method: "DELETE",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      description: `Withdraws the logged in user's bid for this route`,
      validate: {
        params: {
          routeId: Joi.number()
            .integer()
            .required(),
          bidId: Joi.number()
            .integer()
            .required(),
        },
      },
    },
    handler: handleRequestWith(
      (r, request) => getModels(request).Route.findById(request.params.routeId),
      assertFound,
      (route, request) =>
        auth.assertAdminRole(
          request.auth.credentials,
          "manage-routes",
          route.transportCompanyId
        ),
      (r, request) =>
        getModels(request).Bid.findOne({
          where: {
            id: request.params.bidId,
            routeId: request.params.routeId,
            status: "bidded",
          },
        }),
      assertFound,
      existingBid => existingBid.update({ status: "withdrawn" }),
      instToJSONOrNotFound
    ),
  })

  routeRequestsTo(
    server,
    mapToRoots("/routes/{routeId}/bids/{bidId}/convert"),
    {
      method: "POST",
      config: {
        tags: ["api"],
        auth: { access: { scope: ["admin", "superadmin"] } },
        description: `Converts the user's bid for this route into route passes, voiding the bid in the process`,
        validate: {
          params: {
            routeId: Joi.number()
              .integer()
              .required(),
            bidId: Joi.number()
              .integer()
              .required(),
          },
        },
      },
      handler: handleRequestWith(
        (r, request) =>
          getModels(request).Route.findById(request.params.routeId),
        assertFound,
        (route, request) => {
          auth.assertAdminRole(
            request.auth.credentials,
            "manage-routes",
            route.transportCompanyId
          )
          return route
        },
        async (route, request) => ({
          route,
          bid: assertFound(
            await getModels(request).Bid.findOne({
              where: {
                id: request.params.bidId,
                routeId: request.params.routeId,
              },
            })
          ),
        }),
        async ({ route, bid }, request) => {
          const db = getDB(request)
          const models = getModels(request)

          InvalidArgumentError.assert(
            bid.status === "bidded",
            `Bid has status ${bid.status}, not bidded`
          )

          const user = await models.User.findById(bid.userId)
          const customerId = _.get(user, "savedPaymentInfo.id", null)
          const sourceId = _.get(
            user,
            "savedPaymentInfo.sources.data[0].id",
            null
          )
          InvalidArgumentError.assert(
            customerId && sourceId,
            "No stripe card details were found on the user"
          )

          InvalidArgumentError.assert(
            route.tags.includes("success") && route.notes.activatedRouteId,
            "This route has not been activated, or has not been given a live route"
          )

          /* Prepare the transaction */
          const [dbTxn, undoFn] = await purchaseRoutePass({
            userId: bid.userId,
            db,
            models,
            value: bid.priceF * +route.notes.noPasses,
            tag: `crowdstart-${route.notes.activatedRouteId}`,
            companyId: route.transportCompanyId,
            expectedPrice: null,
            transactionType: "conversion",
            postTransactionHook: async transaction =>
              await bid.update({ status: "void" }, { transaction }),
          })

          assert(dbTxn.id)

          let chargeOptions = {
            db,
            models,
            transaction: dbTxn,
            tokenIat: request.auth.credentials.iat,
            paymentDescription: `[Txn #${dbTxn.id}] ` + dbTxn.description,
            customerId,
            sourceId,
          }

          // charge stripe
          try {
            await chargeSale(chargeOptions)
          } catch (err) {
            console.error(err)
            if (err instanceof ChargeError) {
              console.error(err.stack)
              try {
                await undoFn()
              } catch (err2) {
                emit("transactionFailure", {
                  message: `!!! ERROR UNDOING ${dbTxn.id} with ${err2.message}`,
                  userId: request.auth.credentials.userId,
                })
                console.error(err2)
              } finally {
                const notes = {
                  ...bid.notes,
                  [Date.now()]: {
                    transactionId: dbTxn.id,
                    message: err.message,
                  },
                }
                await bid.update({ notes, status: "bidded" })
              }
            }
            throw err
          }

          return dbTxn.toJSON()
        }
      ),
    }
  )

  next()
}

register.attributes = {
  name: "custom-crowdstart",
}
