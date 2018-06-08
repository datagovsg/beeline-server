import _ from "lodash"
import Joi from "joi"
import Boom from "boom"
import stream from "stream"
import fastCSV from "fast-csv"
import { prepareTicketSale, chargeSale, ChargeError } from "../transactions"
import fs from "fs"
import Handlebars from "handlebars"
import path from "path"
import * as auth from "../core/auth"
import leftPad from "left-pad"
import {
  formatDate,
  formatDateLong,
  formatTime12 as formatTime,
  getModels,
  getDB,
  defaultErrorHandler,
  assertUTCMidnight,
  SecurityError,
} from "../util/common"
import BlueBird from "bluebird"
import { emit } from "../events/events"
import * as email from "../util/email"
import { STATUSES as TICKET_STATUSES } from "../models/Ticket"

Handlebars.registerHelper("formatTime", formatTime)
Handlebars.registerHelper("formatDate", formatDate)
Handlebars.registerHelper("formatDateLong", formatDateLong)
Handlebars.registerHelper("formatStop", formatStop)
Handlebars.registerHelper("formatBookingId", formatBookingId)

function escapeLike(s) {
  return s.replace(/[_%\\]/g, s => "\\" + s)
}

export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/custom/wrs/tickets/{id}/{sessionToken}",
    config: {
      tags: ["api", "admin"],
      validate: {
        params: {
          sessionToken: Joi.string().required(),
          id: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let db = getDB(request)

        try {
          var session = auth.verifySession(request.params.sessionToken)
        } catch (err) {
          throw new SecurityError(err)
        }
        let transaction = await getTransaction([db, m], request.params.id)

        // Check whether ticket belongs to user.
        let foundUser = _.some(
          transaction.transactionItems,
          ti => ti.ticketSale && ti.ticketSale.userId === session.userId
        )
        if (!foundUser) {
          return reply(Boom.forbidden())
        }

        // populate the handlebars context
        let context = await contextFromTransaction([db, m], transaction)

        // TODO: send email
        let htmlTemplateText = await BlueBird.promisify(fs.readFile)(
          path.join(path.dirname(module.filename), "../../../data/wrs.html"),
          "utf8"
        )
        let htmlTemplate = Handlebars.compile(htmlTemplateText)

        ;[
          context.logo,
          context.iconPax,
          context.busCoLogo,
        ] = (await Promise.all([
          readFileAsBase64("../../../data/beelineLogo.png"),
          readFileAsBase64("../../../data/iconpax.png"),
          // FIXME: Don't hard code bus company logo!
          readFileAsBase64("../../../data/busplusLogo.png"),
        ])).map(s => "data:image/png;base64," + s)

        return reply(htmlTemplate(context))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/custom/wrs/email/{id}",
    config: {
      tags: ["admin"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let db = getDB(request)
        let m = getModels(request)
        await sendTicketAsEmail(
          [db, m],
          {
            name: "EmailName",
            email: request.auth.credentials.email,
          },
          request.params.id
        )
        reply("Done!")
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/custom/wrs/payment_ticket_sale",
    config: {
      tags: ["api", "admin"],
      description: "Anonymous ticket sales, specially for wildlife reserves =)",
      validate: {
        payload: {
          //          transactionId: Joi.number().integer().required(),
          trips: Joi.array().items(
            Joi.object({
              tripId: Joi.number().integer(),
              boardStopId: Joi.number().integer(),
              alightStopId: Joi.number().integer(),
            })
          ),
          qty: Joi.number()
            .integer()
            .default(1)
            .min(1),
          qtyChildren: Joi.number()
            .integer()
            .default(0)
            .min(0),
          name: Joi.string(),
          email: Joi.string().email(),
          telephone: Joi.string().optional(),
          stripeToken: Joi.string().required(),

          dryRun: Joi.boolean().default(false),
        },
      },
    },
    async handler(request, reply) {
      let db = getDB(request)
      let m = getModels(request)

      if (request.payload.dryRun) {
        return reply(
          Boom.badRequest("Cannot use dryRun with payment_ticket_sale")
        )
      }

      try {
        // Create temporary users
        // To avoid violating the non-unique constraint, we
        // do not set the email or telephone here.
        var userInstances = await Promise.all(
          _.range(request.payload.qty).map(i =>
            m.User.create({
              name: JSON.stringify({
                name: request.payload.name,
                email: request.payload.email,
                telephone: request.payload.telephone,
                createdAt: new Date().getTime(),
                index: i,
                for: "wrs",
                child: i < request.payload.qtyChildren,
              }),
            })
          )
        )

        /* Prepare the transaction */
        let trips = _.flatten(
          request.payload.trips.map((trip /* for each trip */) =>
            _.range(request.payload.qty).map((i /* for each user */) =>
              _.assign(
                {
                  userId: userInstances[i].id,
                  child: i < request.payload.qtyChildren,
                },
                trip
              )
            )
          )
        )

        let [dbTxn, undoFn] = await prepareTicketSale([db, m], {
          trips: trips,
          dryRun: request.payload.dryRun,
          committed: true,
          convertToJson: false,
          creator: {
            type: "user",
            id: request.auth.credentials.userId,
          },
          promoCode: request.payload.qtyChildren
            ? {
                code: "WRS-CHILDREN",
                options: {},
              }
            : null,
        })
        let transactionId = dbTxn.id

        // charge stripe
        try {
          await chargeSale({
            db,
            models: m,
            transaction: dbTxn,
            stripeToken: request.payload.stripeToken,
            tokenIat: request.auth.credentials.iat,
            paymentDescription: `[Txn #${dbTxn.id}] ` + dbTxn.description,
          })
        } catch (err) {
          if (err instanceof ChargeError) {
            try {
              await undoFn()
            } catch (err2) {
              emit("transactionFailure", {
                message: `!!! ERROR UNDOING ${dbTxn.id} with ${err2.message}`,
                userId: request.payload.email,
              })
            }
          }
          throw err
        }

        // sendEmail
        sendTicketAsEmail([db, m], request.payload, transactionId)

        reply({
          transactionid: dbTxn.id,
          transactionId: dbTxn.id,
          sessionToken: userInstances[0].makeToken(),
        })
      } catch (err) {
        console.log(err.stack)
        emit("transactionFailure", {
          userId: userInstances[0].id || 0,
          message: `WRS ${request.payload.email} ${err.message}`,
        })
        defaultErrorHandler(reply)(err)
      }
    },
  })

  async function buildReportQuery(request) {
    const db = getDB(request)
    const m = getModels(request)
    const query = {
      where: {},
      include: [
        {
          model: m.TripStop,
          as: "boardStop",
          include: [
            { model: m.Stop, where: {} },
            {
              model: m.Trip,
              include: [
                {
                  model: m.Route,
                  attributes: { exclude: ["path"] },
                  where: {},
                  include: [
                    {
                      model: m.TransportCompany,
                      attributes: { exclude: ["terms", "features", "logo"] },
                    },
                  ],
                },
              ],
              where: {},
            },
          ],
        },
        {
          model: m.TripStop,
          as: "alightStop",
          include: [{ model: m.Stop, where: {} }],
        },
        { model: m.User, where: {} },
      ],
      attributes: {
        include: [
          [
            db.literal(`(
            SELECT
              payments."paymentResource"
            FROM
              "transactionItems"
              INNER JOIN "transactionItems" AS ti2
                ON "transactionItems"."transactionId" = "ti2"."transactionId"
              INNER JOIN "transactions"
                ON "transactionItems"."transactionId" = "transactions"."id"
              INNER JOIN "payments"
                ON "ti2"."itemType" = 'payment'
                AND "ti2"."itemId" = "payments"."id"
            WHERE
              "transactionItems"."itemId" = "ticket"."id"
              AND "transactionItems"."itemType" = 'ticketSale'
            LIMIT 1
          )`),
            "paymentResource",
          ],
          [
            db.literal(`(
            SELECT
              payments."data"
            FROM
              "transactionItems"
              INNER JOIN "transactionItems" AS ti2
                ON "transactionItems"."transactionId" = "ti2"."transactionId"
              INNER JOIN "transactions"
                ON "transactionItems"."transactionId" = "transactions"."id"
              INNER JOIN "payments"
                ON "ti2"."itemType" = 'payment'
                AND "ti2"."itemId" = "payments"."id"
            WHERE
              "transactionItems"."itemId" = "ticket"."id"
              AND "transactionItems"."itemType" = 'ticketSale'
            LIMIT 1
          )`),
            "paymentData",
          ],
          [
            db.literal(`(
            SELECT
              "refundPayments"."paymentResource"
            FROM
              "transactionItems"
              INNER JOIN "transactionItems" AS ti2
                ON "transactionItems"."transactionId" = "ti2"."transactionId"
              INNER JOIN "transactions"
                ON "transactionItems"."transactionId" = "transactions"."id"
              INNER JOIN "refundPayments"
                ON "ti2"."itemType" = 'refundPayment'
                AND "ti2"."itemId" = "refundPayments"."id"
            WHERE
              "transactionItems"."itemId" = "ticket"."id"
              AND "transactionItems"."itemType" = 'ticketRefund'
            LIMIT 1
          )`),
            "refundResource",
          ],
          [
            db.literal(`(
            SELECT
              "refundPayments"."data"
            FROM
              "transactionItems"
              INNER JOIN "transactionItems" AS ti2
                ON "transactionItems"."transactionId" = "ti2"."transactionId"
              INNER JOIN "transactions"
                ON "transactionItems"."transactionId" = "transactions"."id"
              INNER JOIN "refundPayments"
                ON "ti2"."itemType" = 'refundPayment'
                AND "ti2"."itemId" = "refundPayments"."id"
            WHERE
              "transactionItems"."itemId" = "ticket"."id"
              AND "transactionItems"."itemType" = 'ticketRefund'
            LIMIT 1
          )`),
            "refundData",
          ],
        ],
      },
      order: [["id", "DESC"]],
      limit: request.query.perPage,
      offset: request.query.perPage * (request.query.page - 1),
    }

    let limitByIds = null
    function restrictTicketIds(ids) {
      limitByIds = limitByIds ? _.intersection(ids, limitByIds) : ids
    }

    // Add the filters
    if (request.query.tripStartDate) {
      assertUTCMidnight(request.query.tripStartDate)
      query.include[0].include[1].where.date =
        query.include[0].include[1].where.date || {}
      query.include[0].include[1].where.date.$gte = request.query.tripStartDate
    }
    if (request.query.tripEndDate) {
      assertUTCMidnight(request.query.tripEndDate)
      query.include[0].include[1].where.date =
        query.include[0].include[1].where.date || {}
      query.include[0].include[1].where.date.$lt = request.query.tripEndDate
    }
    if (request.query.startDate) {
      query.createdAt = query.createdAt || {}
      query.createdAt.$gte = request.query.startDate
    }
    if (request.query.endDate) {
      query.createdAt = query.createdAt || {}
      query.createdAt.$lt = request.query.endDate
    }
    if (request.query.routeId) {
      query.include[0].include[1].where.routeId = request.query.routeId
    }
    if (request.query.tripId) {
      query.include[0].include[1].where.id = request.query.tripId
    }
    if (request.query.statuses) {
      query.where.status = { $in: request.query.statuses }
    }
    if (request.query.userQuery) {
      query.include[2].where.$or = [
        { name: { $ilike: `%${escapeLike(request.query.userQuery)}%` } },
        { email: { $ilike: `%${escapeLike(request.query.userQuery)}%` } },
        { telephone: { $ilike: `%${escapeLike(request.query.userQuery)}%` } },
      ]

      let userId = parseInt(request.query.userQuery)
      if (isFinite(userId)) {
        query.include[2].where.$or.push({
          id: userId,
        })
      }
    }
    if (request.query.stopQuery) {
      query.where.$or = query.where.$or || []
      query.where.$or = query.where.$or.concat([
        [
          `"alightStop.stop"."description" ILIKE '%' || ${db.escape(
            request.query.stopQuery
          )} || '%'`,
        ],
        [
          `"boardStop.stop"."description" ILIKE '%' || ${db.escape(
            request.query.stopQuery
          )} || '%'`,
        ],
      ])
    }
    if (request.query.transactionId) {
      // Do a pre-filter to avoid overloading the database
      let validTripIds = await db.query(
        `
          SELECT
            "transactionItems"."itemId" as "id"
          FROM
            "transactions"
            INNER JOIN "transactionItems" ON
              "transactionItems"."transactionId" = transactions.id
          WHERE
            "transactions".id = :txnId
            AND ("transactionItems"."itemType" = 'ticketRefund'
              OR "transactionItems"."itemType" = 'ticketSale'
              OR "transactionItems"."itemType" = 'ticketExpense')
        `,
        {
          type: db.QueryTypes.SELECT,
          replacements: {
            txnId: request.query.transactionId,
          },
        }
      )

      restrictTicketIds(validTripIds.map(s => s.id))
    }
    if (request.query.chargeId && request.query.chargeId.length >= 8) {
      // Do a pre-filter to avoid overloading the database
      let validTripIdsPayments = await db.query(
        `
          SELECT
            "transactionItems"."itemId" as "id"
          FROM
            "payments"
            INNER JOIN "transactionItems" AS "ti2" ON
              ti2."itemType" = 'payment' AND
              ti2."itemId" = payments.id
            INNER JOIN "transactionItems" ON
              "transactionItems"."transactionId" = ti2."transactionId" AND
              "transactionItems"."itemType" IN ('ticketRefund', 'ticketSale', 'ticketExpense')
          WHERE payments."paymentResource" ILIKE ('%' || :query || '%')
        `,
        {
          type: db.QueryTypes.SELECT,
          replacements: {
            query: escapeLike(request.query.chargeId),
          },
        }
      )
      let validTripIdsRefunds = await db.query(
        `
          SELECT
            "transactionItems"."itemId" as "id"
          FROM
            "refundPayments"
            INNER JOIN "transactionItems" AS "ti2" ON
              ti2."itemType" = 'refundPayment' AND
              ti2."itemId" = "refundPayments".id
            INNER JOIN "transactionItems" ON
              "transactionItems"."transactionId" = ti2."transactionId" AND
              "transactionItems"."itemType" IN ('ticketRefund', 'ticketSale', 'ticketExpense')
          WHERE "refundPayments"."paymentResource" ILIKE ('%' || :query || '%')
        `,
        {
          type: db.QueryTypes.SELECT,
          replacements: {
            query: escapeLike(request.query.chargeId),
          },
        }
      )

      restrictTicketIds(
        validTripIdsRefunds.concat(validTripIdsPayments).map(x => x.id)
      )
    }
    if (request.query.paymentId && request.query.paymentId.length >= 8) {
      // Do a pre-filter to avoid overloading the database
      let validTripIdsPayments = await db.query(
        `
          SELECT
            "transactionItems"."itemId" as "id"
          FROM
            "payments"
            INNER JOIN "transactionItems" AS "ti2" ON
              ti2."itemType" = 'payment' AND
              ti2."itemId" = payments.id
            INNER JOIN "transactionItems" ON
              "transactionItems"."transactionId" = ti2."transactionId" AND
              "transactionItems"."itemType" IN ('ticketRefund', 'ticketSale', 'ticketExpense')
          WHERE "payments"."data"->'transfer'->>'destination_payment' ILIKE ('%' || :query || '%')
        `,
        {
          type: db.QueryTypes.SELECT,
          replacements: {
            query: escapeLike(request.query.paymentId),
          },
        }
      )

      restrictTicketIds(validTripIdsPayments.map(x => x.id))
    }
    // ticket Id query
    if (request.query.ticketId) {
      restrictTicketIds([request.query.ticketId])
    }

    if (limitByIds) {
      query.where.id = { $in: limitByIds }
    }

    if (request.query.transportCompanyId) {
      auth.assertAdminRole(
        request.auth.credentials,
        "view-transactions",
        request.query.transportCompanyId
      )
      query.include[0].include[1].include[0].where.transportCompanyId =
        request.query.transportCompanyId
    } else {
      query.include[0].include[1].include[0].where.transportCompanyId = {
        $in: auth.getCompaniesByRole(
          request.auth.credentials,
          "view-transactions"
        ),
      }
    }

    return query
  }

  // Don't load related transaction items yet
  function removeAttributes(includes) {
    return includes.map(includeDefinition => {
      // Use the model-as-attributes
      if (!includeDefinition.model) {
        includeDefinition = {
          model: includeDefinition,
        }
      } else {
        // don't clobber the original include:[]
        includeDefinition = _.assign({}, includeDefinition)
      }

      includeDefinition.attributes = []
      if (includeDefinition.include) {
        includeDefinition.include = removeAttributes(includeDefinition.include)
      }
      return includeDefinition
    })
  }

  async function writeCSVReport(request, reply, query) {
    const db = getDB(request)
    const m = getModels(request)
    const fields = [
      "ticketSale.transaction.id",
      "ticketRefund.transaction.id",
      "ticketExpense.transaction.id",

      "ticketRefund.transaction.description",
      "ticketExpense.transaction.description",

      "routePass.transactionId",
      "routePass.id",
      "routePass.discount",

      "boardStop.trip.date",
      "user.name",
      "user.telephone",
      "user.email",

      "id",
      "paymentResource",
      "paymentData.transfer.destination_payment",
      "refundResource",
      "boardStop.trip.id",
      "boardStop.trip.route.id",
      "boardStop.trip.route.label",
      "boardStop.trip.route.from",
      "boardStop.trip.route.to",
      "boardStop.trip.route.transportCompany.name",

      "boardStop.time",
      "boardStop.stop.description",
      "alightStop.time",
      "alightStop.stop.description",

      "boardStop.trip.price",
      "ticketSale.credit",
      "notes.discountCodes",
      "notes.discountValue",

      "discount.discount.code",
      "discount.discount.description",
      "discount.discount.promotionId",

      "status",
      "createdAt",
      "ticketRefund.createdAt",
    ]

    let writer = fastCSV
      .createWriteStream({
        headers: true,
      })
      .transform(row => {
        let rv = {}
        for (let f of fields) {
          let value = _.get(row, f)

          if (value instanceof Date) {
            rv[f] =
              `${leftPad(value.getFullYear(), 4, "0")}-` +
              `${leftPad(value.getMonth() + 1, 2, "0")}-` +
              `${leftPad(value.getDate(), 2, "0")} ` +
              `${leftPad(value.getHours(), 2, "0")}:` +
              `${leftPad(value.getMinutes(), 2, "0")}:` +
              `${leftPad(value.getSeconds(), 2, "0")}`
          } else if (value instanceof Array) {
            rv[f] = JSON.stringify(value)
          } else {
            rv[f] = value
          }
        }

        try {
          const user = JSON.parse(rv["user.name"])
          rv["user.telephone"] = user["telephone"]
          rv["user.email"] = user["email"]
          rv["user.name"] = user["name"]
        } catch (err) {
          // otherwise do nothing
        }
        return rv
      })
    let io = new stream.PassThrough()

    writer.pipe(io)

    db
      .transaction({ readOnly: true }, async t => {
        let offset = 0
        let batchSize = 100
        while (true) {
          const q = _.clone(query)
          q.transaction = t
          q.offset = offset
          q.limit = batchSize

          const tickets = await m.Ticket.findAll(q) // eslint-disable-line no-await-in-loop
          await augmentTicketsWithTransactionItems({ m, db }, tickets, {
            // eslint-disable-line no-await-in-loop
            transaction: t,
          })

          for (let row of tickets) {
            const writeResult = writer.write(row.toJSON())

            if (!writeResult) {
              await new Promise(resolve => {
                // eslint-disable-line no-await-in-loop
                writer.once("drain", resolve)
              })
            }
          }

          if (tickets.length < batchSize) {
            break
          } else {
            offset += batchSize
          }
        }
      })
      .catch(err => {
        // corrupt output to indicate error
        writer.write({ id: `Error generating output: ${err}` })
      })
      .finally(() => {
        writer.end()
      })

    writer.on("error", err => {
      console.log(err) // There's not much we can do here
    })

    reply(io)
      .header("Content-type", "text/csv")
      .header(
        "content-disposition",
        'attachment; filename="bookings_report.csv"'
      )
  }

  // Given tickets, augment with
  // - ticketSale / ticketRefund / ticketExpense transactions
  // - Further augment with discount transactions
  async function augmentTicketsWithTransactionItems(
    { m, db },
    rows,
    options = {}
  ) {
    const ticketIds = _.uniq(rows.map(r => r.id))

    // Transaction Item
    const transactionItemsQuery = {
      ...options,
      where: {
        itemId: { $in: ticketIds },
        itemType: { $in: ["ticketSale", "ticketRefund", "ticketExpense"] },
      },
      include: [{ model: m.Transaction, where: {} }],
    }
    const transactionItems = await m.TransactionItem.findAll(
      transactionItemsQuery
    )
    const transactionItemsByTicketId = _.groupBy(
      transactionItems,
      ti => ti.itemId
    )

    // match them...
    for (let ticket of rows) {
      let relatedTransactionItems = transactionItemsByTicketId[ticket.id]

      if (!relatedTransactionItems) continue

      for (let ti of relatedTransactionItems) {
        ticket.dataValues[ti.itemType] = ti
      }
    }

    // Transaction Item
    const ticketIdsByTransactionId = _(transactionItems)
      .groupBy(ti => ti.transactionId)
      .mapValues(tiList => tiList.map(ti => ti.itemId))
      .value()
    const discountsQuery = {
      ...options,
      where: {
        transactionId: {
          $in: _.keys(ticketIdsByTransactionId).map(txId => parseInt(txId)),
        },
        itemType: { $in: ["discount"] },
      },
      include: [{ model: m.Discount, as: "discount", where: {} }],
    }
    const discountItems = await m.TransactionItem.findAll(discountsQuery)
    const discountItemsByTicketId = {}
    for (const discountItem of discountItems) {
      const discountAmounts = discountItem.discount.discountAmounts
      const ticketIds = ticketIdsByTransactionId[discountItem.transactionId]
      for (const ticketId of _.intersection(
        ticketIds,
        Object.keys(discountAmounts).map(i => +i)
      )) {
        discountItemsByTicketId[ticketId] = discountItem
      }
    }

    const routePassMetadataTuples = await db.query(
      `SELECT
        "ticketSale"."itemId" AS "ticketId",
        "routePassSale"."transactionId",
        "routePassSale"."itemId" as "id",
        "routePassSale".notes->'routePass'->'notes'->'discountValue' as discount
      FROM
        "transactionItems" "ticketSale"
        INNER JOIN "transactionItems" "routePass" ON "routePass"."transactionId" = "ticketSale"."transactionId" AND "routePass"."itemType" = 'routePass'
        INNER JOIN "transactionItems" "routePassSale" ON "routePassSale"."itemId" = "routePass"."itemId" AND "routePassSale"."itemType" = 'routePass'
        INNER JOIN "transactions" ON "routePassSale"."transactionId" = "transactions".id
      WHERE
        "transactions".type in ('routePassPurchase', 'freeRoutePass', 'conversion')
        AND "ticketSale"."itemType" = 'ticketSale'
        AND "ticketSale"."itemId" = ANY(ARRAY[:ticketIds]::int[])
      `,
      { type: db.QueryTypes.SELECT, replacements: { ticketIds } }
    )

    const routePassMetadataByTicketId = _(routePassMetadataTuples)
      .map(r => [r.ticketId, r])
      .fromPairs()
      .value()

    // match them...
    for (let ticket of rows) {
      const relatedDiscountItem = discountItemsByTicketId[ticket.id]
      if (relatedDiscountItem) {
        ticket.dataValues.discount = relatedDiscountItem
      }
      const routePassMetadata = routePassMetadataByTicketId[ticket.id]
      if (routePassMetadata) {
        ticket.dataValues.routePass = routePassMetadata
      }
    }
  }

  async function writeJSONReport(request, reply, query) {
    const db = getDB(request)
    const m = getModels(request)
    const countQuery = _.assign({}, query, {
      offset: undefined,
      limit: undefined,
      group: ['"boardStop.trip"."date"'],
      order: [],
      attributes: [
        [db.fn("count", db.col("ticket.id")), "count"],
        [db.col("boardStop.trip.date"), "date"],
      ],
      include: removeAttributes(query.include),
      raw: true,
    })
    let [countByDate, rows] = await Promise.all([
      m.Ticket.findAll(countQuery),
      m.Ticket.findAll(query),
    ])

    // Now load the transaction item, and transaction
    await augmentTicketsWithTransactionItems({ m, db }, rows)

    let tickets = rows.map(t => t.toJSON())

    return reply({
      rows: tickets,
      perPage: request.query.perPage,
      page: request.query.page,
      count: _.sumBy(countByDate, cd => parseInt(cd.count)),
      countByDate: _.mapValues(
        _.keyBy(countByDate, cd => cd.date.getTime()),
        cd => cd.count
      ),
    })
  }

  server.route({
    method: "GET",
    path: "/custom/wrs/report",
    config: {
      validate: {
        query: {
          perPage: Joi.number()
            .integer()
            .min(1)
            .max(100)
            .default(20),
          page: Joi.number()
            .integer()
            .min(1)
            .default(1),
          orderBy: Joi.string()
            .valid(["tripDate", "createdAt", "boardingTime"])
            .default("createdAt"),
          order: Joi.string()
            .valid(["desc", "asc"])
            .default("DESC"),
          tripStartDate: Joi.date(),
          tripEndDate: Joi.date(),
          startDate: Joi.date(),
          endDate: Joi.date(),
          routeId: Joi.number()
            .integer()
            .allow(null)
            .allow(""),
          tripId: Joi.number()
            .integer()
            .allow(null)
            .allow(""),
          statuses: Joi.array()
            .items(Joi.string().valid(TICKET_STATUSES))
            .default(TICKET_STATUSES),
          transportCompanyId: Joi.number().integer(),

          format: Joi.string()
            .valid(["csv", "json"])
            .default("json"),

          userQuery: Joi.string(),
          stopQuery: Joi.string(),
          ticketId: Joi.number()
            .integer()
            .allow(null)
            .allow(""),
          transactionId: Joi.number()
            .integer()
            .allow(null)
            .allow(""),
          chargeId: Joi.string(),
          paymentId: Joi.string(),
        },
      },
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      tags: ["api", "admin"],
      description: `Runs the very complicated query to generate WRS reports.`,
    },
    async handler(request, reply) {
      // Find all purchases (ticketSale)
      try {
        const query = await buildReportQuery(request)

        if (request.query.format === "csv") {
          await writeCSVReport(request, reply, query)
        } else {
          await writeJSONReport(request, reply, query)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}

register.attributes = {
  name: "custom-wrs",
}

async function readFileAsBase64(filename, linebreak) {
  let filedata = await BlueBird.promisify(fs.readFile)(
    path.join(path.dirname(module.filename), filename)
  )

  let filedata64 = filedata.toString("base64")

  if (!linebreak) return filedata64

  let parts = ""

  for (let i = 0; i < filedata64.length; i += 80) {
    parts += filedata64.substr(i, 80)
    parts += "\n"
  }
  return parts
}

async function sendTicketAsEmail([db, m], payload, id) {
  let transaction = await getTransaction([db, m], id)
  let context = await contextFromTransaction([db, m], transaction)

  context.logo = "cid:BeeLogo"
  context.iconPax = "cid:iconPax"
  // FIXME: don't hard code bus plus logo here
  context.busCoLogo = "cid:BusCoLogo"

  let htmlTemplateText = await BlueBird.promisify(fs.readFile)(
    path.join(path.dirname(module.filename), "../../../data/wrs.html"),
    "utf8"
  )
  let htmlTemplate = Handlebars.compile(htmlTemplateText)

  let textTemplateText = await BlueBird.promisify(fs.readFile)(
    path.join(path.dirname(module.filename), "../../../data/wrs-textonly.txt"),
    "utf8"
  )
  let textTemplate = Handlebars.compile(textTemplateText)

  let emailTemplateText = await BlueBird.promisify(fs.readFile)(
    path.join(path.dirname(module.filename), "../../../data/wrs.txt"),
    "utf8"
  )

  emailTemplateText = emailTemplateText.replace(/\r\n/g, "\n")
  emailTemplateText = emailTemplateText.replace(/\n/g, "\r\n")

  let emailTemplate = Handlebars.compile(emailTemplateText)

  let emailData = emailTemplate({
    htmlPage: htmlTemplate(context),
    textPage: textTemplate(context),
    date: new Date().toString(),
    customerEmail: payload.email,
    bookingId: formatBookingId(id),
    attachments: [
      {
        mimeType: "image/png",
        filename: "beelineLogo.png",
        contentId: "BeeLogo",
        data: await readFileAsBase64("../../../data/beelineLogo.png", true),
      },
      //        {
      //            mimeType: 'image/png',
      //            filename: 'busplusLogo.png',
      //            contentId: 'BusCoLogo',
      //            data: await readFileAsBase64('../../../data/busplusLogo.png', true)
      //        },
      {
        mimeType: "image/png",
        filename: "iconPax.png",
        contentId: "iconPax",
        data: await readFileAsBase64("../../../data/iconpax.png", true),
      },
    ],
  })

  console.log(emailData.substr(0, 1000))

  await email.send(
    {
      from: `admin@beeline.sg`,
      to: payload.email,
      subject: "Your Beeline Booking",
    },
    emailData
  )
}

async function contextFromTransaction(connection, transaction) {
  let [, m] = connection
  let context = {}

  let txnItems = _.groupBy(transaction.transactionItems, x => x.itemType)

  // Concatenate the list of sold tickets, and the list of issued tickets,
  // since both should be shown on the receipt
  let ticketTransactions = []
  if (txnItems.ticketSale)
    ticketTransactions = ticketTransactions.concat(txnItems.ticketSale)
  if (txnItems.ticketExpense)
    ticketTransactions = ticketTransactions.concat(txnItems.ticketExpense)

  let tickets = ticketTransactions.map(ti => ti[ti.itemType])

  // Find the unique set of trips
  let tripIds = []
  let userIds = []
  for (let ti of ticketTransactions) {
    if (ti[ti.itemType].boardStop) {
      tripIds.push(ti[ti.itemType].boardStop.tripId)
      userIds.push(ti[ti.itemType].userId)
    }
  }
  tripIds = _.uniq(tripIds)
  userIds = _.uniq(userIds)

  // Find routes corresponding to the trips...
  let routes = await m.Route.findAll({
    include: [
      {
        model: m.Trip,
        where: {
          id: { $in: tripIds },
        },
        include: [
          {
            model: m.TripStop,
          },
        ],
      },
    ],
    order: [[m.Trip, m.TripStop, "time", "ASC"]],
  })
  context.trips = routes.map(route => ({
    time: formatTime(route.trips[0].tripStops[0].time),
    description: `${route.from} to ${route.to}`,
  }))

  // payment and booking details
  context.bookingId = leftPad(transaction.id, 4, "0")
  context.amountPaid = "$" + _.get(txnItems, "payment[0].debitF", 0).toFixed(2)
  context.pax = userIds.length

  // Find the number of adults and children
  if (txnItems.discount) {
    context.childPax =
      userIds.length /
      txnItems.ticketSale.length *
      _.size(txnItems.discount[0].discount.discountAmounts)
    context.adultPax = context.pax - context.childPax
  } else {
    context.childPax = 0
    context.adultPax = context.pax
  }

  // user
  let bookingUser = JSON.parse(tickets[0].user.name)
  context.user = {
    name: bookingUser.name,
  }

  // stops
  let toTicket = tickets.find(ti =>
    ti.alightStop.stop.description.includes("Zoo")
  )

  let fromTicket = tickets.find(ti =>
    ti.boardStop.stop.description.includes("Zoo")
  )

  context.toZoo = toTicket || null
  context.fromZoo = fromTicket || null

  context.date = tickets[0].boardStop.time

  return context
}

async function getTransaction(connection, id) {
  let [, m] = connection
  let transaction = await m.Transaction.findById(id, {
    include: [
      {
        model: m.TransactionItem,
        where: {
          itemType: {
            $in: ["payment", "ticketSale", "ticketExpense", "discount"],
          },
        },
      },
    ],
  })

  let ticketIncludeOptions = {
    include: [
      {
        model: m.TripStop,
        as: "boardStop",
        include: [m.Stop],
      },
      {
        model: m.TripStop,
        as: "alightStop",
        include: [m.Stop],
      },
      m.User,
    ],
  }
  await m.TransactionItem.getAssociatedItems(transaction.transactionItems, {
    ticketSale: ticketIncludeOptions,
    ticketExpense: ticketIncludeOptions,
    discount: {},
  })

  return transaction
}

function formatBookingId(id) {
  return "BEE-" + leftPad(id, 4, "0")
}

function formatStop(stop) {
  return `${stop.description}`
  //  if (stop.type == 'Bus Stop') {
  //    return `${stop.description} (${stop.label})`
  //  }
  //  else {
  //    return `${stop.description}`
  //  }
}
