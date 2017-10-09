const _ = require("lodash")
const Joi = require("joi")
const Boom = require("boom")
const stream = require('stream')
const fastCSV = require('fast-csv')

const {getModels, getDB, defaultErrorHandler, InvalidArgumentError} = require("../util/common")

import fs from 'fs'
import Handlebars from 'handlebars'
import path from 'path'
import * as auth from '../core/auth'
import leftPad from 'left-pad'
import BlueBird from 'bluebird'

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/transaction_items",
    config: {
      tags: ["api"],
      description:
`Get all transaction items, with sort etc.`,
      auth: { access: { scope: ['admin', 'superadmin'] }},
      validate: {
        query: {
          /* pagination options */
          perPage: Joi.number().integer().min(1).default(20),
          page: Joi.number().integer().min(1).default(1),
          orderBy: Joi.string()
            .valid(['createdAt', 'transactionId', 'itemType'])
            .default('createdAt'),
          order: Joi.string().valid(['desc', 'asc'])
            .default('DESC'),

          /* filter options */
          startDate: Joi.date()
            .default(() => new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000), 'Far in the past'),
          endDate: Joi.date()
            .default(() => new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000), 'Far in the future'),

          itemTypes: Joi.array()
            .items(Joi.string().valid([
              'payment',
              'refundPayment',
              'ticketSale',
              'ticketRefund',
              'ticketExpense',
              'account',
              'transfer',
              'routeCredits',
              'routePass',
              'discount',
            ]))
            .optional(),
          transactionId: Joi.number().integer(),
          userQuery: Joi.string(),
          format: Joi.string().valid(['csv', 'json', 'statement'])
            .default('json'),
          ticketId: Joi.number().integer(),
        }
      }
    },
    async handler (request, reply) {
      try {
        var db = getDB(request)
        var m = getModels(request)

        var companyIds = auth.getCompaniesByRole(request.auth.credentials, 'view-transactions')

        var authorizationClause =
          (request.auth.credentials.scope === 'public') ? '1=1'
            : (request.auth.credentials.scope === 'superadmin') ? '1=1'
              : (request.auth.credentials.scope === 'admin')
                ? `"tickets"."boardStopId" IN
            (SELECT "tripStops"."id"
              FROM "tripStops"
              INNER JOIN "trips"
                ON "tripStops"."tripId" = "trips"."id"
              INNER JOIN "routes"
                ON "trips"."routeId" = "routes"."id"
              WHERE "routes"."transportCompanyId" = ANY(${db.escape(companyIds)}))`
                : (request.auth.credentials.scope === 'user')
                  ? `"tickets"."userId" = ${db.escape(request.auth.credentials.userId)}`
                  : '1=0'

        var userSearchClause = request.query.userQuery ? `
          ("tickets"."userId" IN
            (SELECT "id" FROM "users" WHERE
              ("email"     ILIKE ('%' || ${db.escape(request.query.userQuery)} || '%')) OR
              ("name"      ILIKE ('%' || ${db.escape(request.query.userQuery)} || '%')) OR
              ("telephone" ILIKE ('%' || ${db.escape(request.query.userQuery)} || '%'))
            ))
        ` : ' 1=1 '

        var ticketClause = request.query.ticketId ? `
          ("tickets"."id" = ${db.escape(request.query.ticketId)})`
          : ' 1=1 '

        var ticketTypes = ["ticketSale", "ticketExpense", "ticketRefund"]
        var query = {
          where: {
            transactionId: {
              $in: db.literal(`
                (SELECT
                  "transactionItems"."transactionId"
                FROM
                  "transactionItems" INNER JOIN "tickets"
                  ON "transactionItems"."itemType" = ANY(${db.escape(ticketTypes)})
                  AND "transactionItems"."itemId" = tickets.id
                  AND ${userSearchClause}
                  AND ${authorizationClause}
                  AND ${ticketClause}
                )
                `)
            }
          },
          limit: request.query.perPage,
          offset: request.query.perPage * (request.query.page - 1),
          order: [[request.query.orderBy, request.query.order]],
          include: [m.Transaction],
        }

        // Construct query based on parameters
        if (request.query.itemTypes) {
          query.where.itemType = {
            $in: request.query.itemTypes
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
        var {count, rows: transactionItems} = await m.TransactionItem.findAndCountAll(query)

        //
        var ticketIncludes = [
          {
            model: m.TripStop,
            as: "boardStop",
            include: [
              m.Stop,
              {
                model: m.Trip,
                include: [
                  {model: m.Route, attributes: {exclude: ['path']}}
                ]
              }
            ],
          },
          {model: m.TripStop, as: "alightStop", include: [m.Stop]},
          {model: m.User, attributes: ["email", "name", "telephone"]}
        ]
        await m.TransactionItem.getAssociatedItems(transactionItems, {
          ticketSale: { include: ticketIncludes },
          ticketRefund: { include: ticketIncludes },
          ticketExpense: { include: ticketIncludes },
        })

        if (request.query.format === 'csv') {
          var fields = [
            'transactionId',
            'id',
            'itemType',
            'itemId',
            'createdAt',
            'transaction.committed',
            'debit',
            'payment.paymentResource',
            'payment.incoming',
            'account.name',
            'user.name',
            'user.telephone',
            'user.email',
            'ticketSale.id',
            'ticketSale.userId',
            'ticketSale.boardStop.trip.routeId',
            'ticketExpense.id',
            'ticketExpense.boardStop.trip.routeId',
            'ticketRefund.id',
            'ticketRefund.boardStop.trip.routeId',
          ]

          var writer = fastCSV.createWriteStream({
            headers: true,
          }).transform((row) => {
            var rv = {}
            for (let f of fields) {
              let value = _.get(row, f)
              if (value instanceof Date) {
                rv[f] = `${leftPad(value.getFullYear(), 4, '0')}-` +
                    `${leftPad(value.getMonth() + 1, 2, '0')}-` +
                    `${leftPad(value.getDate(), 2, '0')} ` +
                    `${leftPad(value.getHours(), 2, '0')}:` +
                    `${leftPad(value.getMinutes(), 2, '0')}:` +
                    `${leftPad(value.getSeconds(), 2, '0')}`
              } else {
                rv[f] = value
              }
            }
            return rv
          })
          var io = new stream.PassThrough()

          writer.pipe(io)
          for (let row of transactionItems) {
            writer.write(row.toJSON())
          }
          writer.end()

          reply(io)
            .header('Content-type', 'text/csv')
            .header('content-disposition', 'attachment; filename="transactions_report.csv"')
        } else if (request.query.format === 'statement') {
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
        console.log(err.stack)
        reply(Boom.badImplementation("Error during purchase. " + err.message))
      }
    }
  })

  const routeCreditsQuerySchema = {
    startDateTime: Joi.date()
      .default(() => new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000), 'Far in the past'),
    endDateTime: Joi.date()
      .default(() => new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000), 'Far in the future'),
    tag: Joi.string().optional().description('a comma-separated list of tags'),
    userId: Joi.number().integer().min(1).optional(),
    transactionType: Joi.string().optional(),
    hideUncommittedTransactions: Joi.boolean().default(false),
  }

  const buildRoutePassQueryFor = (itemType, modelName) => request => {
    const m = getModels(request)
    const db = getDB(request)
    const {companyId} = request.params
    const {userId, startDateTime, endDateTime,
      transactionType, hideUncommittedTransactions, tag} = request.query

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
      itemTypeWhereClause.tag = { $overlap: tag.split(',') }
    }

    return {
      where: {
        itemType,
        createdAt: { $gte: startDateTime, $lt: endDateTime }
      },
      order: [['id', 'desc']],
      include: [{
        model: m[modelName],
        where: itemTypeWhereClause,
        include: [
          { model: m.User, attributes: ['email', 'name', 'telephone'] },
        ],
        attributes: {
          include: [
            [
              db.literal(`(
                SELECT
                  jsonb_build_object('label', label, 'name', name)
                FROM
                  routes
                WHERE
                  "routePass".tag = ANY(routes.tags)
                LIMIT 1
              )`),
              'route'
            ]
          ]
        },
        as: itemType
      }, {
        model: m.Transaction,
        include: [{
          model: m.TransactionItem,
          where: {
            itemType: {$notIn: ['account', 'transfer']}
          },
          separate: true,
        }],
        where: transactionWhereClause
      }],
      attributes: {
        include: [
          [
            db.literal(`(
              SELECT
                "transactionId"
              FROM
                "transactionItems" "refundingTransaction"
              WHERE
                "refundingTransaction".notes IS NOT NULL
                AND "refundingTransaction".notes->>'refundedTransactionId' = "transactionItem"."transactionId"::text
                AND "refundingTransaction"."itemType" = '${itemType}'
                AND "refundingTransaction"."itemId" = "transactionItem"."itemId"
              LIMIT 1
            )`),
            'refundingTransactionId'
          ]
        ]
      }
    }
  }

  const buildRoutePassQuery = buildRoutePassQueryFor('routePass', 'RoutePass')

  server.route({
    method: "GET",
    path: "/companies/{companyId}/transaction_items/route_passes",
    config: {
      tags: ["api"],
      description: 'Get all route pass transaction items, and those related to it',
      auth: { access: { scope: ['admin', 'superadmin'] }},
      validate: {
        query: {
          ...routeCreditsQuerySchema,
          perPage: Joi.number().integer().min(1).max(100).default(20),
          page: Joi.number().integer().min(1).default(1),
          format: Joi.string()
            .valid(['json', 'csvdump'])
            .description('json, or csvdump. csvdump ignores perPage and page')
            .default('json'),
        }
      }
    },
    async handler (request, reply) {
      const getTransactionItems = async (m, query, page, perPage, transaction) => {
        const entryOffset = (page - 1) * perPage
        return m.TransactionItem.findAll({
          ...query,
          limit: perPage,
          offset: entryOffset,
          transaction,
        })
      }

      const routePassCSVFields = [
        'transactionId', 'transaction.createdAt', 'transaction.type',
        'refundingTransactionId',
        'routePass.expiresAt', 'routePass.status',
        'routePass.notes.ticketId',
        'routePass.route.label', 'routePass.route.name',
        'routePass.tag',
        'routePass.user.name',
        'routePass.user.email',
        'routePass.user.telephone',
        'credit',
        'routePass.notes.discountValue'
      ]

      const routePassJSONToCSV = row => {
        const isoStringIfDate = value => value instanceof Date
          ? value.toISOString() : value
        const csv = _(routePassCSVFields)
          .map(f => [f, isoStringIfDate(_.get(row, f))])
          .fromPairs()
          .value()
        return csv
      }

      try {
        auth.assertAdminRole(request.auth.credentials, 'view-transactions', request.params.companyId)
        const db = getDB(request)
        const m = getModels(request)
        const query = buildRoutePassQuery(request)

        if (request.query.format === 'csvdump') {
          const io = new stream.PassThrough()
          const writer = fastCSV
            .createWriteStream({ headers: true })
            .transform(routePassJSONToCSV)
          writer.pipe(io)

          reply(io)
            .header('Content-type', 'text/csv')
            .header('content-disposition', 'attachment; filename="route_pass_report.csv"')

          db.transaction(async transaction => {
            const perPage = 100
            var page = 1
            var pageSize = 100
            while (pageSize >= perPage) {
              const relatedTransactionItems = await getTransactionItems(m, query, page, perPage, transaction) // eslint-disable-line no-await-in-loop
              for (const row of relatedTransactionItems) {
                if (!writer.write(row.toJSON())) {
                  await new Promise((resolve) => { // eslint-disable-line no-await-in-loop
                    writer.once('drain', resolve)
                  })
                }
              }
              pageSize = relatedTransactionItems.length
              ++page
            }
          }).catch(err => {
            // corrupt output to indicate error
            writer.write({id: `Error generating output: ${err}`})
          }).finally(() => {
            writer.end()
          })

          writer.on('error', (err) => {
            console.log(err) // There's not much we can do here
          })
        } else if (request.query.format === 'json') {
          const {page, perPage} = request.query
          const relatedTransactionItems = await getTransactionItems(m, query, page, perPage)

          reply(relatedTransactionItems)
        } else {
          throw new InvalidArgumentError(`Unrecognized format argument: ${request.query.format}`)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/transaction_items/route_passes/summary",
    config: {
      tags: ["api"],
      description: 'Count the number of route pass transaction items broken down by day',
      auth: { access: { scope: ['admin', 'superadmin'] }},
      validate: {
        query: {
          ...routeCreditsQuerySchema,
        }
      }
    },
    async handler (request, reply) {
      try {
        const db = getDB(request)
        const m = getModels(request)

        auth.assertAdminRole(request.auth.credentials, 'view-transactions', request.params.companyId)

        const query = buildRoutePassQuery(request)
        const transactionDateExpression = `("transactionItem"."createdAt" AT TIME ZONE interval '+08:00')::date`

        const takeNoAttributes = (include) => ({
          ...include,
          attributes: [],
          include: include.include ? include.include.map(takeNoAttributes) : []
        })

        let items = await m.TransactionItem.findAll({
          ...query,
          include: query.include.map(takeNoAttributes),
          group: [db.literal(transactionDateExpression)],
          attributes: [
            [db.fn('count', db.literal('distinct "transactionItem"."id"')), 'count'],
            [db.literal(transactionDateExpression), 'date']
          ],
          raw: true, // Summary doesn't need consolidation
          order: [], // Summary has no order
        })

        const totalItems = _.sum(items.map(i => parseInt(i.count)))

        let txnCountByDay = _(items)
          .keyBy(i => i.date.getTime())
          .mapValues(i => parseInt(i.count))
          .value()

        reply({totalItems, txnCountByDay})
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}
register.attributes = {
  name: "endpoint-transaction-items"
}

// FIXME: HOw to namespace this thing? Restrict to instance?
Handlebars.registerHelper('sumCredit', rows => _.sumBy(rows, r => parseFloat(r.credit)).toFixed(2))
Handlebars.registerHelper('sumDedit', rows => _.sumBy(rows, r => parseFloat(r.debit)).toFixed(2))

async function generateStatement (transactionItems, query) {
  // Group the items by their type
  var itemsByType = _(transactionItems)
    .filter(ti => ti.transaction.committed)
    .groupBy(ti => ti.itemType)
    .value()

  //
  var htmlTemplateText = await BlueBird.promisify(fs.readFile)(
    path.join(__dirname, '../../../data/statement.html'), 'utf8')
  var htmlTemplate = Handlebars.compile(htmlTemplateText)

  return htmlTemplate({
    data: itemsByType,
    query: query,
  })
}
