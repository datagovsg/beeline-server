const _ = require("lodash")
const Joi = require("joi")
const Boom = require("boom")
const stream = require("stream")
const fastCSV = require("fast-csv")
const moment = require("moment-timezone")

const {
  getModels,
  getDB,
  defaultErrorHandler,
  InvalidArgumentError,
} = require("../util/common")

import fs from "fs"
import Handlebars from "handlebars"
import path from "path"
import * as auth from "../core/auth"
import BlueBird from "bluebird"

/**
 * @param {object} server the HAPI Server
 * @param {object} options not used
 * @param {function} next the callback used to indicate that the other register funcs can be invoked
 */
export function register(server, options, next) {
  const toSGTDateString = date =>
    moment(date)
      .tz("Asia/Singapore")
      .format("YYYY-MM-DD")

  const sgtStringIfDate = value =>
    value instanceof Date ? toSGTDateString(value) : value

  server.route({
    method: "GET",
    path: "/transaction_items",
    config: {
      tags: ["api"],
      description: `Get all transaction items, with sort etc.`,
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        query: {
          /* pagination options */
          perPage: Joi.number()
            .integer()
            .min(1)
            .default(20),
          page: Joi.number()
            .integer()
            .min(1)
            .default(1),
          orderBy: Joi.string()
            .valid(["createdAt", "transactionId", "itemType"])
            .default("createdAt"),
          order: Joi.string()
            .valid(["desc", "asc"])
            .default("DESC"),

          /* filter options */
          startDate: Joi.date().default(
            () => new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000),
            "Far in the past"
          ),
          endDate: Joi.date().default(
            () => new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
            "Far in the future"
          ),

          itemTypes: Joi.array()
            .items(
              Joi.string().valid([
                "payment",
                "refundPayment",
                "ticketSale",
                "ticketRefund",
                "ticketExpense",
                "account",
                "transfer",
                "routeCredits",
                "routePass",
                "discount",
              ])
            )
            .optional(),
          transactionId: Joi.number().integer(),
          userQuery: Joi.string(),
          format: Joi.string()
            .valid(["csv", "json", "statement"])
            .default("json"),
          ticketId: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      try {
        const db = getDB(request)
        const m = getModels(request)

        const companyIds = auth.getCompaniesByRole(
          request.auth.credentials,
          "view-transactions"
        )

        const authorizationClause =
          request.auth.credentials.scope === "public"
            ? "1=1"
            : request.auth.credentials.scope === "superadmin"
              ? "1=1"
              : request.auth.credentials.scope === "admin"
                ? `"tickets"."boardStopId" IN
            (SELECT "tripStops"."id"
              FROM "tripStops"
              INNER JOIN "trips"
                ON "tripStops"."tripId" = "trips"."id"
              INNER JOIN "routes"
                ON "trips"."routeId" = "routes"."id"
              WHERE "routes"."transportCompanyId" = ANY(${db.escape(
                companyIds
              )}))`
                : request.auth.credentials.scope === "user"
                  ? `"tickets"."userId" = ${db.escape(
                      request.auth.credentials.userId
                    )}`
                  : "1=0"

        const userSearchClause = request.query.userQuery
          ? `
          ("tickets"."userId" IN
            (SELECT "id" FROM "users" WHERE
              ("email"     ILIKE ("%" || ${db.escape(
                request.query.userQuery
              )} || "%")) OR
              ("name"      ILIKE ("%" || ${db.escape(
                request.query.userQuery
              )} || "%")) OR
              ("telephone" ILIKE ("%" || ${db.escape(
                request.query.userQuery
              )} || "%"))
            ))
        `
          : " 1=1 "

        const ticketClause = request.query.ticketId
          ? `
          ("tickets"."id" = ${db.escape(request.query.ticketId)})`
          : " 1=1 "

        const ticketTypes = ["ticketSale", "ticketExpense", "ticketRefund"]
        const query = {
          where: {
            transactionId: {
              $in: db.literal(`
                (SELECT
                  "transactionItems"."transactionId"
                FROM
                  "transactionItems" INNER JOIN "tickets"
                  ON "transactionItems"."itemType" = ANY(${db.escape(
                    ticketTypes
                  )})
                  AND "transactionItems"."itemId" = tickets.id
                  AND ${userSearchClause}
                  AND ${authorizationClause}
                  AND ${ticketClause}
                )
                `),
            },
          },
          limit: request.query.perPage,
          offset: request.query.perPage * (request.query.page - 1),
          order: [[request.query.orderBy, request.query.order]],
          include: [m.Transaction],
        }

        // Construct query based on parameters
        if (request.query.itemTypes) {
          query.where.itemType = {
            $in: request.query.itemTypes,
          }
        }
        if (request.query.transactionId) {
          query.where.transactionId = request.query.transactionId
        }
        if (request.query.startDate) {
          query.where.createdAt = query.where.createdAt || {}
          query.where.createdAt.$gte = request.query.startDate
        }
        if (request.query.endDate) {
          query.where.createdAt = query.where.createdAt || {}
          query.where.createdAt.$lt = request.query.endDate
        }

        //
        const {
          count,
          rows: transactionItems,
        } = await m.TransactionItem.findAndCountAll(query)

        //
        const ticketIncludes = [
          {
            model: m.TripStop,
            as: "boardStop",
            include: [
              m.Stop,
              {
                model: m.Trip,
                include: [{ model: m.Route, attributes: { exclude: ["path"] } }],
              },
            ],
          },
          { model: m.TripStop, as: "alightStop", include: [m.Stop] },
          { model: m.User, attributes: ["email", "name", "telephone"] },
        ]
        await m.TransactionItem.getAssociatedItems(transactionItems, {
          ticketSale: { include: ticketIncludes },
          ticketRefund: { include: ticketIncludes },
          ticketExpense: { include: ticketIncludes },
        })

        if (request.query.format === "csv") {
          const fields = [
            "transactionId",
            "id",
            "itemType",
            "itemId",
            "createdAt",
            "transaction.committed",
            "debit",
            "payment.paymentResource",
            "payment.incoming",
            "account.name",
            "user.name",
            "user.telephone",
            "user.email",
            "ticketSale.id",
            "ticketSale.userId",
            "ticketSale.boardStop.trip.routeId",
            "ticketExpense.id",
            "ticketExpense.boardStop.trip.routeId",
            "ticketRefund.id",
            "ticketRefund.boardStop.trip.routeId",
          ]

          const writer = fastCSV
            .createWriteStream({
              headers: true,
            })
            .transform(row => {
              const rv = {}
              for (let f of fields) {
                rv[f] = sgtStringIfDate(_.get(row, f))
              }
              return rv
            })
          const io = new stream.PassThrough()

          writer.pipe(io)
          for (let row of transactionItems) {
            writer.write(row.toJSON())
          }
          writer.end()

          reply(io)
            .header("Content-type", "text/csv")
            .header(
              "content-disposition",
              'attachment; filename="transactions_report.csv"'
            )
        } else if (request.query.format === "statement") {
          reply(await generateStatement(transactionItems, request.query))
        } else {
          reply({
            rows: transactionItems.map(t => t.toJSON()),
            page: request.query.page,
            perPage: request.query.perPage,
            count: count,
            pageCount: Math.ceil(count / request.query.perPage),
          })
        }
      } catch (err) {
        console.error(err)
        reply(Boom.badImplementation("Error during purchase. " + err.message))
      }
    },
  })

  const routeCreditsQuerySchema = {
    startDateTime: Joi.date().default(
      () => new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000),
      "Far in the past"
    ),
    endDateTime: Joi.date().default(
      () => new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      "Far in the future"
    ),
    tag: Joi.string()
      .optional()
      .description("a comma-separated list of tags"),
    userId: Joi.number()
      .integer()
      .min(1)
      .optional(),
    transactionType: Joi.string().optional(),
    hideUncommittedTransactions: Joi.boolean().default(false),
  }

  const buildRoutePassQueryFor = (itemType, modelName) => request => {
    const m = getModels(request)
    const { companyId } = request.params
    const {
      userId,
      startDateTime,
      endDateTime,
      transactionType,
      hideUncommittedTransactions,
      tag,
    } = request.query

    let transactionWhereClause = {}
    if (hideUncommittedTransactions) {
      transactionWhereClause.committed = true
    }
    if (transactionType) {
      transactionWhereClause.type = transactionType
    }

    let itemTypeWhereClause = { companyId }
    if (userId) {
      itemTypeWhereClause.userId = userId
    }
    if (tag) {
      itemTypeWhereClause.tag = { $in: tag.split(",") }
    }

    return {
      where: {
        itemType,
        createdAt: { $gte: startDateTime, $lt: endDateTime },
      },
      order: [["id", "desc"]],
      include: [
        {
          model: m[modelName],
          where: itemTypeWhereClause,
          include: [
            { model: m.User, attributes: ["email", "name", "telephone"] },
          ],
          as: itemType,
        },
        {
          model: m.Transaction,
          attributes: ["id", "createdAt", "committed", "type", "description"],
          where: transactionWhereClause,
        },
      ],
    }
  }

  const buildRoutePassQuery = buildRoutePassQueryFor("routePass", "RoutePass")

  const keyBy = field => rows =>
    _(rows)
      .map(r => [r[field], _.omit(r, field)])
      .fromPairs()
      .value()

  const addRouteMetadataTo = async (db, routePassItems) => {
    const routeTags = _(routePassItems)
      .map(r => r.routePass.tag)
      .uniq()
      .value()
    if (routeTags.length === 0) {
      return routePassItems
    }
    const routeMetadata = await db
      .query(
        `SELECT
          tag, label, name
        FROM
          routes, "routePasses"
        WHERE
          "routePasses".tag = ANY(routes.tags)
          AND "routePasses".tag in (:routeTags)
        `,
        { type: db.QueryTypes.SELECT, replacements: { routeTags } }
      )
      .then(keyBy("tag"))
    routePassItems
      .map(r => r.routePass)
      .forEach(r => _.assign(r, { route: routeMetadata[r.tag] }))
    return routePassItems
  }

  const addPaymentMetadataTo = async (db, routePassItems) => {
    const ids = _(routePassItems)
      .filter(r =>
        ["routePassPurchase", "conversion"].includes(r.transaction.type)
      )
      .map(r => r.id)
      .value()
    if (ids.length === 0) {
      return routePassItems
    }
    const [
      refundMetadata,
      paymentMetadata,
      discountMetadata,
    ] = await Promise.all([
      db
        .query(
          `SELECT
            ti.id,
            "refundingTransaction"."transactionId" as "refundingTransactionId",
            "paymentResource" as "refundResource"
          FROM
            "transactionItems" "refundingTransaction",
            "transactionItems" "refundPaymentItem",
            "refundPayments",
            "transactionItems" ti
          WHERE
            "refundingTransaction".notes IS NOT NULL
            AND "refundingTransaction".notes->>'refundedTransactionId' = ti."transactionId"::text
            AND "refundingTransaction"."itemType" = 'routePass'
            AND "refundingTransaction"."itemId" = ti."itemId"
            AND "refundingTransaction"."transactionId" = "refundPaymentItem"."transactionId"
            AND "refundPayments".id = "refundPaymentItem"."itemId"
            AND ti.id in (:ids)
          `,
          { type: db.QueryTypes.SELECT, replacements: { ids } }
        )
        .then(keyBy("id")),
      db
        .query(
          `SELECT
            ti."id",
            "paymentResource",
            "payments".data->'transfer'->>'destination_payment' as "transferResource",
            "payments".data->>'message' as "paymentMessage"
          FROM
            "transactionItems" "paymentItem",
            "payments",
            "transactionItems" ti
          WHERE
            "paymentItem"."transactionId" = ti."transactionId"
            AND "paymentItem"."itemType" = 'payment'
            AND "paymentItem"."itemId" = "payments"."id"
            AND ti.id in (:ids)
          `,
          { type: db.QueryTypes.SELECT, replacements: { ids } }
        )
        .then(keyBy("id")),
      db
        .query(
          `SELECT
            ti."id",
            "discounts"."code",
            "discounts"."promotionId",
            "discounts"."description"
          FROM
            "transactionItems" "discountItem",
            "discounts",
            "transactionItems" ti
          WHERE
            "discountItem"."transactionId" = ti."transactionId"
            AND "discountItem"."itemType" = 'discount'
            AND "discountItem"."itemId" = "discounts"."id"
            AND ti.id in (:ids)
          `,
          { type: db.QueryTypes.SELECT, replacements: { ids } }
        )
        .then(discounts =>
          discounts.map(discount => ({ id: discount.id, discount }))
        )
        .then(keyBy("id")),
    ])

    routePassItems.forEach(r =>
      _.assign(
        r,
        refundMetadata[r.id],
        paymentMetadata[r.id],
        discountMetadata[r.id]
      )
    )
    return routePassItems
  }

  const addBoardStopMetadataTo = async (db, routePassItems) => {
    const ids = _(routePassItems)
      .filter(r => r.transaction.type === "ticketPurchase")
      .map(r => r.id)
      .value()
    if (ids.length === 0) {
      return routePassItems
    }
    const boardStopMetadata = await db
      .query(
        `SELECT
          ti."id",
          "tripStops".time
        FROM
          "transactionItems" "ticketSale",
          "tickets",
          "tripStops",
          "transactionItems" ti
        WHERE
          "ticketSale"."transactionId" = ti."transactionId"
          AND "ticketSale"."itemType" = 'ticketSale'
          AND "ticketSale"."itemId" = "tickets"."id"
          AND "ti"."notes"->'tickets'->"tickets"."id"::text is not null
          AND "tickets"."boardStopId" = "tripStops".id
          AND ti.id in (:ids)
        `,
        { type: db.QueryTypes.SELECT, replacements: { ids } }
      )
      .then(keyBy("id"))
    routePassItems.forEach(r => {
      const boardStop = boardStopMetadata[r.id]
      if (boardStop) {
        const tripDate = toSGTDateString(boardStop.time)
        _.assign(r, { tripDate })
      }
      return r
    })
    return routePassItems
  }

  server.route({
    method: "GET",
    path: "/companies/{companyId}/transaction_items/route_passes",
    config: {
      tags: ["api"],
      description:
        "Get all route pass transaction items, and those related to it",
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        query: {
          ...routeCreditsQuerySchema,
          perPage: Joi.number()
            .integer()
            .min(1)
            .max(100)
            .default(20),
          page: Joi.number()
            .integer()
            .min(1)
            .default(1),
          format: Joi.string()
            .valid(["json", "csvdump"])
            .description("json, or csvdump. csvdump ignores perPage and page")
            .default("json"),
        },
      },
      timeout: {
        server: false,
        socket: false,
      },
    },
    async handler(request, reply) {
      const getTransactionItems = async (
        m,
        db,
        query,
        page,
        perPage,
        transaction
      ) => {
        const entryOffset = (page - 1) * perPage
        const routePassItems = await m.TransactionItem.findAll({
          ...query,
          limit: perPage,
          offset: entryOffset,
          transaction,
        }).then(passes => passes.map(r => r.toJSON()))
        await addRouteMetadataTo(db, routePassItems)
        await addBoardStopMetadataTo(db, routePassItems)
        await addPaymentMetadataTo(db, routePassItems)
        return routePassItems
      }

      const routePassCSVFields = [
        "transactionId",
        "transaction.createdAt",
        "transaction.committed",
        "transaction.type",
        "transaction.description",
        "refundingTransactionId",
        "paymentResource",
        "transferResource",
        "refundResource",
        "routePass.id",
        "routePass.expiresAt",
        "routePass.status",
        "routePass.notes.ticketId",
        "tripDate",
        "routePass.route.label",
        "routePass.route.name",
        "routePass.tag",
        "routePass.user.name",
        "routePass.user.email",
        "routePass.user.telephone",
        "credit",
        "routePass.notes.discountValue",
        "discount.promotionId",
        "discount.code",
        "discount.description",
      ]

      const routePassJSONToCSV = row => {
        const csv = _(routePassCSVFields)
          .map(f => [f, sgtStringIfDate(_.get(row, f))])
          .fromPairs()
          .value()
        return csv
      }

      try {
        auth.assertAdminRole(
          request.auth.credentials,
          "view-transactions",
          request.params.companyId
        )
        const db = getDB(request)
        const m = getModels(request)
        const query = buildRoutePassQuery(request)

        if (request.query.format === "csvdump") {
          let connected = true
          request.once("disconnect", () => (connected = false))
          const io = new stream.PassThrough()
          const writer = fastCSV
            .createWriteStream({ headers: true })
            .transform(routePassJSONToCSV)
          writer.pipe(io)

          reply(io)
            .header("Content-type", "text/csv")
            .header(
              "content-disposition",
              'attachment; filename="route_pass_report.csv"'
            )

          db
            .transaction({ readOnly: true }, async transaction => {
              let untilBatchWritten = Promise.resolve(true)
              const perPage = 20
              let page = 1
              let lastFetchedSize = perPage
              while (connected && lastFetchedSize >= perPage) {
                console.warn(`Retrieving ${perPage} items at page ${page}`)
                const relatedTransactionItems = await getTransactionItems(
                  m,
                  db,
                  query,
                  page,
                  perPage,
                  transaction
                )
                await untilBatchWritten
                untilBatchWritten = new Promise(async batchWritten => {
                  console.warn(`Writing items at page ${page}`)
                  for (const row of relatedTransactionItems) {
                    if (!writer.write(row)) {
                      await new Promise(resolve => {
                        writer.once("drain", resolve)
                      })
                    }
                  }
                  batchWritten()
                })
                lastFetchedSize = relatedTransactionItems.length
                ++page
              }
            })
            .catch(err => {
              // corrupt output to indicate error
              console.error(err)
              writer.write({
                transactionId: `Error generating output: ${err}`,
              })
            })
            .finally(() => {
              writer.end()
            })

          writer.on("error", err => {
            console.error(err)
          })
        } else if (request.query.format === "json") {
          const { page, perPage } = request.query
          const relatedTransactionItems = await getTransactionItems(
            m,
            db,
            query,
            page,
            perPage
          )

          reply(relatedTransactionItems)
        } else {
          throw new InvalidArgumentError(
            `Unrecognized format argument: ${request.query.format}`
          )
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/transaction_items/route_passes/summary",
    config: {
      tags: ["api"],
      description:
        "Count the number of route pass transaction items broken down by day",
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        query: {
          ...routeCreditsQuerySchema,
        },
      },
    },
    async handler(request, reply) {
      try {
        const db = getDB(request)
        const m = getModels(request)

        auth.assertAdminRole(
          request.auth.credentials,
          "view-transactions",
          request.params.companyId
        )

        const query = buildRoutePassQuery(request)
        const transactionDateExpression = `("transactionItem"."createdAt" AT TIME ZONE interval '+08:00')::date`

        const takeNoAttributes = include => ({
          ...include,
          attributes: [],
          include: include.include ? include.include.map(takeNoAttributes) : [],
        })

        // Summary doesn"t need consolidation and has no order
        let items = await m.TransactionItem.findAll({
          ...query,
          include: query.include.map(takeNoAttributes),
          group: [db.literal(transactionDateExpression)],
          attributes: [
            [
              db.fn("count", db.literal('distinct "transactionItem"."id"')),
              "count",
            ],
            [db.literal(transactionDateExpression), "date"],
          ],
          raw: true,
          order: [],
        })

        const totalItems = _.sum(items.map(i => parseInt(i.count)))

        let txnCountByDay = _(items)
          .keyBy(i => i.date.getTime())
          .mapValues(i => parseInt(i.count))
          .value()

        reply({ totalItems, txnCountByDay })
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-transaction-items",
}

// FIXME: HOw to namespace this thing? Restrict to instance?
Handlebars.registerHelper("sumCredit", rows =>
  _.sumBy(rows, r => parseFloat(r.credit)).toFixed(2)
)
Handlebars.registerHelper("sumDedit", rows =>
  _.sumBy(rows, r => parseFloat(r.debit)).toFixed(2)
)

/**
 * Generate an HTML document bearing transaction item statements
 * @param {array} transactionItems an array of transaction items
 * @param {object} query the query made
 * @return {object} an HTML document showing the queried transaction items
 */
async function generateStatement(transactionItems, query) {
  // Group the items by their type
  const itemsByType = _(transactionItems)
    .filter(ti => ti.transaction.committed)
    .groupBy(ti => ti.itemType)
    .value()

  //
  const htmlTemplateText = await BlueBird.promisify(fs.readFile)(
    path.join(__dirname, "../../../data/statement.html"),
    "utf8"
  )
  const htmlTemplate = Handlebars.compile(htmlTemplateText)

  return htmlTemplate({
    data: itemsByType,
    query: query,
  })
}
