const _ = require("lodash")
const Joi = require("joi")
const Boom = require("boom")
const {toSVY} = require("../util/svy21")
const leftPad = require('left-pad')

import assert from 'assert'
import * as auth from '../core/auth'
import {getModels, getDB, defaultErrorHandler, InvalidArgumentError, TransactionError} from '../util/common'
import {purchaseRoutePass} from '../transactions'
import commonmark from 'commonmark'

export function register (server, options, next) {
  const stringDate = d => d && [
    leftPad(d.getFullYear(), 4, '0'),
    leftPad(d.getMonth() + 1, 2, '0'),
    leftPad(d.getDate(), 2, '0'),
  ].join('-')

  function fetchAllRoutes (request) {
    // simulate loading a lot of stuff
    return uncachedFetchRoutes({
      ...request,
      query: {
        ...request.query,
        includeTrips: true,
        includeIndicative: false,
        includePath: true,
        startDate: new Date(),
        endDate: null,
        limitTrips: 5,
        transportCompanyId: null,
        tags: null,
        label: null,
      }
    })
  }

  let currentRoutesPromise = null
  function cachedFetchRoutes (request) {
    if (!currentRoutesPromise) {
      setTimeout(() => (currentRoutesPromise = null), process.env.ROUTES_REFRESH_INTERVAL || 300000)
      currentRoutesPromise = fetchAllRoutes(request).then(routes => {
        for (let route of routes) {
          route._cached = true
        }
        return routes
      })
    }
    return currentRoutesPromise
  }

  function filterCached (routes, request) {
    return routes.filter(r => {
      return (!request.query.transportCompanyId || r.transportCompanyId === request.query.transportCompanyId) &&
        (!request.query.tags || _.every(request.query.tags, tag => r.tags && r.tags.find(t => t === tag))) &&
        (!request.query.label || r.label === request.query.label)
    })
      .map(r => {
        const base = _.omit(r, ['path', 'trips'])

        if (request.query.includePath) {
          base.path = r.path
        }
        if (request.query.includeTrips) {
          base.trips = r.trips

          if (request.query.endDate) {
            const compare = stringDate(request.query.endDate)
            base.trips = base.trips.filter(t =>
              t.date.toISOString().substr(0, 10) <= compare)
          }
          if (request.query.limitTrips) {
            base.trips = base.trips.slice(0, request.query.limitTrips)
          }
        }
        return base
      })
      .filter(r => !request.query.includeTrips || r.trips.length > 0)
  }

  async function uncachedFetchRoutes (request) {
    const m = getModels(request)
    const db = getDB(request)
    const routeQuery = {
      where: undefined,
      include: [],
      attributes: {
        exclude: []
      }
    }
    // additional options
    if (request.query.transportCompanyId) {
      routeQuery.where = routeQuery.where || {}
      routeQuery.where.transportCompanyId = request.query.transportCompanyId
    }
    if (request.query.tags && request.query.tags.length > 0) {
      routeQuery.where = routeQuery.where || {}
      routeQuery.where.tags = {$contains: request.query.tags}
    }
    if (request.query.companyTags && request.query.companyTags.length > 0) {
      routeQuery.where = routeQuery.where || {}
      routeQuery.where.companyTags = {$contains: request.query.companyTags}
    }
    if (request.query.label) {
      routeQuery.where = routeQuery.where || {}
      routeQuery.where.label = request.query.label
    }
    // Filter by dates
    if ((request.query.startDate || request.query.endDate) && !request.query.includeTrips) {
      routeQuery.where = routeQuery.where || {}
      routeQuery.where.$and = routeQuery.where.$and || []

      let startDateExpr = request.query.startDate && request.query.startDate.toISOString()
      let endDateExpr = request.query.endDate && request.query.endDate.toISOString()

      routeQuery.where.$and.push([
        `"route".id IN (SELECT "routeId" FROM "trips" INNER JOIN "tripStops"
              ON "trips"."id" = "tripStops"."tripId"
              WHERE
                (${db.escape(startDateExpr)} IS NULL OR "tripStops"."time" >= ${db.escape(startDateExpr)})
                AND (${db.escape(endDateExpr)} IS NULL OR "tripStops"."time" < ${db.escape(endDateExpr)})
            )`
      ])
    }
    if (request.query.includePath) {
      routeQuery.attributes = undefined
    } else {
      routeQuery.attributes.exclude.push("path")
    }

    if (request.query.includeIndicative) {
      routeQuery.include.push(m.IndicativeTrip)
    }

    let routes = await m.Route.findAll(routeQuery)
    routes = routes.map(r => r.toJSON())

    if (request.query.includeDates) {
      const dateQuery = `
        select
          a."routeId",
          min(a.date) as "firstDate",
          max(a.date) as "lastDate"
        from
          trips a
        where
          a."routeId" in (:routeId)
        group by a."routeId"`
      const routeDates = await db.query(dateQuery, {
        replacements: {
          routeId: routes.map(r => r.id),
        },
        raw: true,
        type: db.QueryTypes.SELECT,
      })
      const routeDatesById = _.keyBy(routeDates, 'routeId')
      routes.forEach(route => {
        route.dates = routeDatesById[route.id] || {}
      })
    }

    if (request.query.includeTrips) {
      const startDateQuery = request.query.startDate
        ? `"trips".date >= :startDate` : '1=1'

      const endDateQuery = request.query.endDate
        ? `"trips".date <= :endDate` : '1=1'

      const stringDate = d => d && [
        leftPad(d.getFullYear(), 4, '0'),
        leftPad(d.getMonth() + 1, 2, '0'),
        leftPad(d.getDate(), 2, '0'),
      ].join('-')

      const tripQueries = []

      for (var i = 0; i < routes.length; i += 10) {
        const routeIdBatch = routes.slice(i, i + 10).map(r => r.id)
        const tripIdsQuery = routeIdBatch.map(routeId =>
          `
            (SELECT "id" FROM "trips"
            WHERE
            trips."routeId" = (${routeId})
            AND ${startDateQuery}
            AND ${endDateQuery}
            ORDER BY "date"
            LIMIT :limitTrips)
          `
        ).join(' UNION ')
        const tripIdsBatch = await db.query(tripIdsQuery, { // eslint-disable-line no-await-in-loop
          replacements: {
            startDate: stringDate(request.query.startDate),
            endDate: stringDate(request.query.endDate),
            limitTrips: request.query.limitTrips,
          },
          raw: true,
          type: db.QueryTypes.SELECT
        })
        tripQueries.push(m.Trip.findAll({
          where: {
            id: {$in: tripIdsBatch.map(t => t.id)},
          },
          include: [{
            model: m.TripStop,
            attributes: {exclude: ['createdAt', 'updatedAt']},
            include: [{
              model: m.Stop,
              attributes: {exclude: ['createdAt', 'updatedAt']}
            }],
          }],
          order: [
            ['id'],
            [m.TripStop, 'time']
          ],
          attributes: {exclude: ['createdAt', 'updatedAt']},
        }))
      }

      const trips = await Promise.all(tripQueries).then(_.flatten)

      const tripsByRouteId = _.groupBy(trips, 'routeId')

      return routes
        .filter(route => tripsByRouteId[route.id])
        .map(route => ({
          ...route,
          trips: _.sortBy(tripsByRouteId[route.id].map(t => t.toJSON()), 'date')
        }))
    } else {
      return routes
    }
  }

  const routeCommonParams = {
    startDate: Joi.date(),
    endDate: Joi.date(),
    includeIndicative: Joi.boolean().default(false),
    includeTrips: Joi.boolean().optional().description("Include trips, tripStops and stops"),
    includeDates: Joi.boolean().optional().description("Include first, last and next trip dates"),
  }

  server.route({
    method: "GET",
    path: "/routes",
    config: {
      tags: ["api"],
      description:
            `List of all routes. Authentication not required.
If \`includeTrips\` is \`true\`, and \`startDate\` is not specified,
the \`startDate\` defaults to the time of request.
            `,
      validate: {
        query: {
          ...routeCommonParams,
          includePath: Joi.boolean().default(false),
          limitTrips: Joi.number().integer().default(5).max(5),
          transportCompanyId: Joi.number().integer().optional(),
          tags: Joi.array().items(Joi.string()),
          companyTags: Joi.array().items(Joi.string()),
          label: Joi.string().optional(),
        }
      }
    },
    handler: async function (request, reply) {
      try {
        const now = new Date()
        if (
          request.auth.credentials.scope !== 'admin' &&
          request.auth.credentials.scope !== 'superadmin' &&
          /* same date */
          request.query.startDate &&
          request.query.startDate.getFullYear() === now.getFullYear() &&
          request.query.startDate.getMonth() === now.getMonth() &&
          request.query.startDate.getDate() === now.getDate() &&
          !request.query.includeIndicative
        ) {
          reply(cachedFetchRoutes(request).then(routes => filterCached(routes, request)))
        } else {
          reply(uncachedFetchRoutes(request))
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/routes/{id}",
    config: {
      auth: false,
      tags: ["api"],
      description: "List route details",
      validate: {
        params: {
          id: Joi.number()
        },
        query: {
          ...routeCommonParams,
          includeFeatures: Joi.boolean().default(false),
        }
      }
    },
    handler: async function (request, reply) {
      var m = getModels(request)
      try {
        var routeQuery = {
          where: {
            id: request.params.id
          },
          include: [],
          attributes: {
            include: []
          }
        }
        if (request.query.includeIndicative) {
          routeQuery.include.push(m.IndicativeTrip)
        }

        if (request.query.includeFeatures) {
          routeQuery.attributes.include.push("features")
        } else {
          routeQuery.attributes = undefined
        }

        var route = await m.Route.find(routeQuery)
        if (!route) {
          return reply(Boom.notFound())
        }
        route = route.toJSON()
        if (route.indicativeTrip && route.indicativeTrip.tripId) {
          route.indicativeTrip.tripStops = await m.TripStop.findAll({
            where: {tripId: route.indicativeTrip.tripId},
            include: [m.Stop],
            order: ['time']
          })
          route.indicativeTrip.tripStops =
            route.indicativeTrip.tripStops.map(ts => ts.toJSON())
        }

        if (request.query.includeDates) {
          const dateQuery = `
            select
            min(a.date) as "firstDate",
            max(a.date) as "lastDate"
            from trips a
            where
            a."routeId" = :routeId`
          const db = getDB(request)
          const routeDates = await db.query(dateQuery, {
            replacements: {
              routeId: route.id,
            },
            raw: true,
            type: db.QueryTypes.SELECT,
          })
          route.dates = routeDates && routeDates.length > 0 ? routeDates[0] : {}
        }

        if (request.query.includeTrips) {
          var tripQuery = {
            where: {
              routeId: route.id,
            },
            include: [{
              model: m.TripStop,
              include: [m.Stop],
              where: {
              },
              required: false
            }],
            order: [[m.TripStop, "time", "ASC"]]
          }
          if (request.query.startDate) {
            tripQuery.include[0].where.time = tripQuery.include[0].where.time || {}
            tripQuery.include[0].where.time.$gte = request.query.startDate

            tripQuery.where.date = tripQuery.where.date || {}
            tripQuery.where.date.$gte = new Date(Date.UTC(
              request.query.startDate.getFullYear(),
              request.query.startDate.getMonth(),
              request.query.startDate.getDate()
            ))
          }
          if (request.query.endDate) {
            tripQuery.include[0].where.time = tripQuery.include[0].where.time || {}
            tripQuery.include[0].where.time.$lte = request.query.endDate
          }
          route.trips = await m.Trip.findAll(tripQuery)
          route.trips = route.trips
            .filter(tr => tr.tripStops.length !== 0)
            .map(tr => tr.toJSON())
        }

        reply(route)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/routes/{id}/price_schedule",
    config: {
      tags: ["api"],
      description: `
        Looks up the pricing of tickets for a given route,
        factoring in prevailing discounts at query time.
        Returns a map of ticket quantity to price and discount (in absolute terms).
        Single ticket purchases will not account for default promotion discounts.
        Route pass purchases will account for default promotion discounts to
        reflect the benefits of bulk purchases.
      `,
      validate: {
        params: {
          id: Joi.number()
        },
      }
    },
    handler: async function (request, reply) {
      const m = getModels(request)
      const route = await m.Route.find({
        where: { id: request.params.id },
        include: [{
          model: m.IndicativeTrip,
          attributes: ['nextPrice'],
        }]
      })
      if (!route) {
        return reply(Boom.notFound())
      }
      const ticketPrice = route.indicativeTrip.nextPrice
      const pricing = {
        1: {
          price: parseFloat(ticketPrice),
        }
      }

      const eligibleTags = route.tags.filter(t => t.startsWith('rp-'))

      if (eligibleTags.length > 0 && route.notes && route.notes.passSizes) {
        let passSizes = [...new Set(route.notes.passSizes)] || []
        const options = {
          db: getDB(request),
          models: m,
          userId: request.auth && request.auth.credentials
            ? request.auth.credentials.userId : undefined,
          dryRun: true,
          tag: eligibleTags[0],
          promoCode: { code: '' },
          companyId: route.transportCompanyId,
          expectedPrice: null,
        }
        const toTransaction = size =>
          purchaseRoutePass(_.assign({}, options, { quantity: size }))

        const passSizeQuotes = []
        for (const passSize of passSizes) {
          passSizeQuotes.push(await toTransaction(passSize).catch(e => console.error(e))) // eslint-disable-line no-await-in-loop
        }

        const bulkPricing = _(passSizeQuotes)
          .filter(Boolean)
          .map(([transactionData]) => transactionData.transactionItems)
          .map(items => items.filter(item => ['discount', 'payment'].includes(item.itemType)))
          .map(items => {
            const pricing = {}
            for (const item of items) {
              const key = item.itemType === 'payment' ? 'price' : item.itemType
              pricing[key] = pricing[key] ? pricing[key] + item.debit : item.debit
            }
            return pricing
          })
          .zip(passSizes)
          .map(pair => pair.reverse())
          .fromPairs()
          .value()

        _.assign(pricing, bulkPricing)
      }

      return reply(pricing)
    }
  })

  server.route({
    method: "POST",
    path: "/routes",
    config: {
      tags: ["api"],
      description: "Create a new route",
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        payload: Joi.object({
          features: Joi.string().allow('').required(),
          transportCompanyId: Joi.number().integer().required(),
          from: Joi.string().required(),
          to: Joi.string().required(),
          label: Joi.string().optional(),
          tags: Joi.array().items(Joi.string()).optional(),
          companyTags: Joi.array().items(Joi.string()).optional(),
        }).unknown()
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)

        await auth.assertAdminRole(request.auth.credentials, 'manage-routes', request.payload.transportCompanyId)

        if (request.auth.credentials.scope !== 'superadmin') {
          /* Label and tags are set by superadmin */
          delete request.payload.label
          delete request.payload.tags
        }

        // remove duplicate tags if available
        if (request.payload.tags) {
          request.payload.tags = _.uniq(request.payload.tags)
        }

        if (request.payload.companyTags) {
          request.payload.companyTags = _.uniq(request.payload.companyTags)
        }

        var routeInst = await m.Route.create(_.omit(request.payload, 'createdAt'))
        reply(routeInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "PUT",
    path: "/routes/{id}",
    config: {
      tags: ["api"],
      description: "Update a route (for admin and superadmin only)",
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer()
        },
        payload: Joi.object({
          features: Joi.string().allow('').optional(),
          transportCompanyId: Joi.number().integer().optional(),
          from: Joi.string().optional(),
          to: Joi.string().optional(),
          label: Joi.string().optional(),
          tags: Joi.array().items(Joi.string()).optional(),
          companyTags: Joi.array().items(Joi.string()).optional(),
        }).unknown()
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var routeInst = await m.Route.findById(request.params.id)

        if (!routeInst) {
          return reply(Boom.notFound())
        }
        await auth.assertAdminRole(request.auth.credentials, 'manage-routes', routeInst.transportCompanyId)
        if (request.payload.transportCompanyId) {
          await auth.assertAdminRole(request.auth.credentials, 'manage-routes', request.payload.transportCompanyId)
        }

        if (request.auth.credentials.scope !== 'superadmin') {
          /* Label and tags are set by superadmin */
          delete request.payload.label
          delete request.payload.tags
        }

        // remove duplicate tags if available
        if (request.payload.tags) {
          request.payload.tags = _.uniq(request.payload.tags)
        }

        if (request.payload.companyTags) {
          request.payload.companyTags = _.uniq(request.payload.companyTags)
        }

        await routeInst.update(request.payload)

        reply(routeInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "DELETE",
    path: "/routes/{id}",
    config: {
      tags: ["api"],
      description: "Delete a route (for admin and superadmin only)",
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number()
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var routeInst = await m.Route.findById(request.params.id)

        await auth.assertAdminRole(request.auth.credentials, 'manage-routes', routeInst.transportCompanyId)
        await routeInst.destroy()

        reply("")
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/routes/search_by_region",
    config: {
      tags: ["api"],
      description: "Search by region.",
      auth: false,
      validate: {
        query: {
          regionId: Joi.number().integer().optional(),
          areaName: Joi.string().optional(),
          startTime: Joi.date().optional(),
          endTime: Joi.date().optional()
        }
      }
    },
    handler: function (request, reply) {
      var db = getDB(request)
      db.query(`
            SELECT
                routes.*,
                (SELECT MAX(date) FROM trips WHERE trips."routeId" = routes."id") AS "last_trip",
                (SELECT MIN(date) FROM trips WHERE trips."routeId" = routes."id") AS "first_trip",
                (SELECT MAX(date) FROM trips WHERE trips."routeId" = routes."id") AS "lastTrip",
                (SELECT MIN(date) FROM trips WHERE trips."routeId" = routes."id") AS "firstTrip"
            FROM "routes"
                INNER JOIN "routeRegions"
                    ON "routeRegions"."routeId" = "routes"."id"
                INNER JOIN "regions"
                    ON "routeRegions"."regionId" = "regions"."id"
            WHERE
                (:regionId IS NULL OR "regions"."id" = :regionId)
                AND (:areaName IS NULL OR "regions"."areaName" = :areaName)

                AND EXISTS(SELECT * FROM trips
                            WHERE
                                trips."routeId" = routes."id"
                                AND (:startTime IS NULL OR trips."date" >= :startTime)
                                AND (:endTime IS NULL OR trips."date" <= :endTime))
            `,
        {
          replacements: {
            areaName: request.query.areaName || null,
            regionId: request.query.regionId || null,
            startTime: request.query.startTime || null,
            endTime: request.query.endTime || null
          },
          type: db.QueryTypes.SELECT
        }).then((res) => { reply(res) }, defaultErrorHandler(reply))
    }
  })

  function latLngDistance (ll1, ll2) {
    var svy1 = toSVY(ll1)
    var svy2 = toSVY(ll2)

    return Math.sqrt((svy1[0] - svy2[0]) * (svy1[0] - svy2[0]) +
                            (svy1[1] - svy2[1]) * (svy1[1] - svy2[1]))
  }

  server.route({
    method: "GET",
    path: "/routes/search_by_latlon",
    config: {
      tags: ["api"],
      description: `
Search by latitude and longitude, and arrival time.
This handler will return routes in sorted order of ascending (walking) distance.
`,
      auth: false,
      validate: {
        query: {
          startLat: Joi.number().description("Lat of pickup point"),
          startLng: Joi.number().description("Lng of pickup point"),
          endLat: Joi.number().description("Lat of dropoff point"),
          endLng: Joi.number().description("Lng of dropoff point"),
          arrivalTime: Joi.date()
            .default(() => new Date(), "Current time")
            .description(`
Time at which user wants to arrive. Give any date, as long as the time is correct.
The difference between the arrival time and what the user requested will be returned.`),
          startTime: Joi.date()
            .default(() => new Date(), "Current time")
            .description("Restrict to trips starting after this date/time."),
          endTime: Joi.date()
            .default(() => new Date(new Date().getTime() + 365 * 24 * 3600000), "Current time + 365 days")
            .description("Restrict to trips before this date/time"),
          maxDistance: Joi.number().integer()
            .description("Max distance on either end in meters")
            .default(5000)
            .max(5000),
          includeAvailability: Joi.boolean(),
          tags: Joi.array().items(Joi.string()),
          transportCompanyId: Joi.number().integer().optional()
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var db = getDB(request)

        var wantStart = (request.query.startLat && request.query.startLng)
        var wantEnd = (request.query.endLat && request.query.endLng)

        var startXY = wantStart && toSVY([request.query.startLng, request.query.startLat])
        var endXY = wantEnd && toSVY([request.query.endLng, request.query.endLat])

        // Either startLat or startLng must be specified
        TransactionError.assert(wantStart || wantEnd)

        // Show only routes with trips on the queried dates.
        const validRouteIds = await (() => {
          const boardTimeQuery = request.query.startTime ? `
            ("tripStops".time >= :startTime)
          ` : '1=1'

          const alightTimeQuery = request.query.endTime ? `
            ("tripStops".time <= :endTime)
          ` : '1=1'

          const boardQuery = wantStart ? `EXISTS
          (SELECT "tripId"
          FROM "tripStops" INNER JOIN "stops" ON "tripStops"."stopId" = stops.id
          WHERE
            ${boardTimeQuery} AND ${alightTimeQuery} AND
            "tripStops"."tripId" = "trips".id AND
            ST_distance(
              ST_Transform(ST_SetSRID(stops.coordinates, 4326), 3414),
              ST_GeomFromText('POINT(${startXY[0]} ${startXY[1]})', 3414)
            ) < :maxDistance)` : '1=1'

          const alightQuery = wantEnd ? `EXISTS
          (SELECT "tripId"
          FROM "tripStops" INNER JOIN "stops" ON "tripStops"."stopId" = stops.id
          WHERE
            ${boardTimeQuery} AND ${alightTimeQuery} AND
            "tripStops"."tripId" = "trips".id AND
            ST_distance(
              ST_Transform(ST_SetSRID(stops.coordinates, 4326), 3414),
              ST_GeomFromText('POINT(${endXY[0]} ${endXY[1]})', 3414)
            ) < :maxDistance)` : '1=1'

          const transportCompanyQuery = request.query.transportCompanyId
            ? `routes."transportCompanyId" = :transportCompanyId`
            : `1=1`

          const tagsQuery = request.query.tags && request.query.tags.length > 0
            ? `routes."tags" @> array[:tags]::varchar[]`
            : `1=1`

          return db.query(
            `
            SELECT DISTINCT ON (trips."routeId")
              trips."routeId",
              trips.id as "tripId"
            FROM trips
              INNER JOIN "routes" ON "trips"."routeId" = routes.id
            WHERE
              ${boardQuery} AND
              ${alightQuery} AND
              ${transportCompanyQuery} AND
              ${tagsQuery}
              `,
            {
              replacements: {
                transportCompanyId: request.query.transportCompanyId,
                tags: request.query.tags || [],
                startTime: request.query.startTime,
                endTime: request.query.endTime,
                maxDistance: request.query.maxDistance,
              },
              type: db.QueryTypes.SELECT,
            }
          )
        })()

        var routeQuery = {
          include: [{
            model: m.Trip,
            include: [{
              model: m.TripStop,
              include: [m.Stop],
              separate: true
            }],
            /* We do a DISTINCT ON (routeId) so there will only
            be at most one trip per route, sufficient for the client
            to display the stops in a route */
            where: {id: {$in: validRouteIds.map(t => t.tripId)}}
          }]
        }

        var allRouteInstances = await m.Route.findAll(routeQuery)

        // For each route, compute the nearest SVY21 distance
        // and the time difference
        let queryMinsSinceMidnight = ((dt) => dt.getHours() * 60 + dt.getMinutes() + dt.getSeconds())(new Date(request.query.arrivalTime))

        allRouteInstances = allRouteInstances.map((rinst) => rinst.toJSON())
        for (let routeInst of allRouteInstances) {
          // distance = min{over boarding stops} d(boarding_stop, start) +
          //             min{over alighting stops} d(alighting_stop, end)
          routeInst.trips = _.sortBy(routeInst.trips, 'date')

          for (let trip of routeInst.trips) {
            // calculate: distanceToStart
            if (wantStart) {
              trip.tripStops = _.sortBy(trip.tripStops, 'time')
              for (let tripStop of trip.tripStops) {
                if (!tripStop.canBoard ||
                              !tripStop.stop ||
                              !tripStop.stop.coordinates) { continue }

                let distanceToStart = latLngDistance(
                  [request.query.startLng, request.query.startLat], tripStop.stop.coordinates.coordinates)
                if (typeof (routeInst.distanceToStart) === "undefined" ||
                                  distanceToStart < routeInst.distanceToStart) {
                  routeInst.distanceToStart = distanceToStart
                  routeInst.nearestBoardStop = tripStop
                }
              }
            }

            // calculate: distanceToEnd, timeDifference
            if (wantEnd) {
              for (let tripStop of trip.tripStops) {
                if (!tripStop.canAlight ||
                            !tripStop.stop ||
                            !tripStop.stop.coordinates) { continue }
                let distanceToEnd = latLngDistance(
                  [request.query.endLng, request.query.endLat], tripStop.stop.coordinates.coordinates)
                if (typeof (routeInst.distanceToEnd) === "undefined" ||
                                distanceToEnd < routeInst.distanceToEnd) {
                  routeInst.distanceToEnd = distanceToEnd
                  routeInst.nearestAlightStop = tripStop
                }

                // time difference -- measure alight time
                let minsSinceMidnight
                let alightTime = tripStop.time

                minsSinceMidnight = alightTime.getHours() * 60 +
                            alightTime.getMinutes() +
                            alightTime.getSeconds() / 60

                let timeDifference = Math.abs(minsSinceMidnight - queryMinsSinceMidnight)
                if (typeof (routeInst.timeDifference) === "undefined" ||
                                Math.abs(timeDifference) < Math.abs(routeInst.timeDifference)) {
                  routeInst.timeDifference = timeDifference
                }
              }
            }
          }
          routeInst.distanceToQuery = (wantStart ? routeInst.distanceToStart : 0) +
                        (wantEnd ? routeInst.distanceToEnd : 0)
        }

        allRouteInstances = allRouteInstances
          .filter((a) => a.distanceToQuery < request.query.maxDistance) // nobody walks 10km
          .sort((a, b) => a.distanceToQuery - b.distanceToQuery)

        reply(allRouteInstances)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/routes/recent",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        query: Joi.object({
          limit: Joi.number().integer().default(10)
        }).unknown()
      }
    },

    async handler (request, reply) {
      try {
        var db = getDB(request)

        var recentRoutes = await db.query(`
WITH "routeIdLastTicketDate" AS (
    SELECT DISTINCT ON (trips."routeId")
        trips."routeId",
        -- FIXME: free tickets will also be reflected here
        -- for more correct implementation we should be looking at the associated
        -- transaction's date

        "tripStops"."stopId" AS "boardStopStopId",
        "alightStop"."stopId" AS "alightStopStopId",
        "tickets"."createdAt" AS "lastTicketDate",
        "tickets"."userId"
    FROM
        tickets
        INNER JOIN "tripStops"
            ON tickets."boardStopId" = "tripStops".id
        INNER JOIN trips
            ON "tripStops"."tripId" = trips.id

        -- extract the alighting stop
        INNER JOIN "tripStops" AS "alightStop"
            ON tickets."alightStopId" = "alightStop".id
    WHERE
        "userId" = :userId
    ORDER BY
        "trips"."routeId", "tickets".id DESC
)
SELECT
  routes.*,
  "routeIdLastTicketDate"."boardStopStopId",
  "routeIdLastTicketDate"."alightStopStopId"
FROM routes INNER JOIN "routeIdLastTicketDate"
  ON routes.id = "routeIdLastTicketDate"."routeId"
ORDER BY
    "routeIdLastTicketDate"."lastTicketDate" DESC
LIMIT :limit
                `, {
            replacements: {
              userId: request.auth.credentials.userId,
              limit: request.query.limit
            },
            type: db.QueryTypes.SELECT
          })

        reply(recentRoutes)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/routes/similarToRecent",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['user']}},
      validate: {
        query: Joi.object({
          maxDistance: Joi.number().integer().default(500),
          startDateTime: Joi.date()
            .default(() => new Date(), "current time"),
          endDateTime: Joi.date()
            .default(() => new Date(Date.now() + 7 * 24 * 3600 * 1000), 'T+7 days'),
        }).unknown()
      }
    },
    async handler (request, reply) {
      try {
        const db = getDB(request)
        const m = getModels(request)

        const stopQuery = function (coordinates, distance) {
          assert.strictEqual(typeof coordinates.coordinates[0], 'number')
          assert.strictEqual(typeof coordinates.coordinates[1], 'number')
          assert.strictEqual(typeof distance, 'number')
          return `(ST_distance(
           ST_Transform(ST_SetSRID(stop.coordinates, 4326), 3414),
           ST_Transform(ST_SetSRID(ST_GeomFromText('POINT(${coordinates.coordinates[0]} ${coordinates.coordinates[1]})'),
            4326),3414)
         ) < ${distance})`
        }

        const fetchRouteIds = async function ({board, alight}) {
          // find the trips matching, probably those with trips in the next week
          const boardQuery = stopQuery(board, request.query.maxDistance)
          const alightQuery = stopQuery(alight, request.query.maxDistance)

          const similarTrips = await db.query(`
            SELECT "id", "routeId" FROM "trips"
            WHERE
              EXISTS(SELECT "tripStops".id
                     FROM "tripStops" INNER JOIN "stops" AS "stop"
                          ON "stop".id = "tripStops"."stopId"
                     WHERE "trips".id = "tripStops"."tripId"
                        AND "tripStops"."time" >= :startDateTime
                        AND "tripStops"."time" <= :endDateTime
                        AND ${boardQuery})
              AND
              EXISTS(SELECT "tripStops".id
                     FROM "tripStops" INNER JOIN "stops" AS "stop"
                          ON "stop".id = "tripStops"."stopId"
                     WHERE "trips".id = "tripStops"."tripId"
                        AND "tripStops"."time" >= :startDateTime
                        AND "tripStops"."time" <= :endDateTime
                        AND ${alightQuery})
          `, {
            type: db.QueryTypes.SELECT,
            replacements: {
              endDateTime: request.query.endDateTime,
              startDateTime: request.query.startDateTime,
            }
          })

          return [similarTrips.map(t => t.routeId), board, alight]
        }

        // Find recent board, alight pairs
        const recentStopLatLngPairs = (await db.query(`
          -- Retrieve only the last 5 (by id)
          -- Need to wrap around the subquery because the DISTINCT ON (X)
          -- in the subquery requires the subquery to be sorted by X
          SELECT * FROM
            -- unique routes from a user's tickets
            (SELECT DISTINCT ON("trips"."routeId")
              "boardStop.stop"."coordinates" as "board",
              "alightStop.stop"."coordinates" as "alight",
              "trips"."routeId" as "routeId",
              "tickets"."id" as "ticketId"
            FROM
              "tickets"
              INNER JOIN "tripStops" AS "boardStop" ON "boardStop"."id" = tickets."boardStopId"
              INNER JOIN "tripStops" AS "alightStop" ON "alightStop"."id" = tickets."alightStopId"
              INNER JOIN "stops" AS "boardStop.stop" ON "boardStop.stop"."id" = "boardStop"."stopId"
              INNER JOIN "stops" AS "alightStop.stop" ON "alightStop.stop"."id" = "alightStop"."stopId"
              INNER JOIN "trips" ON "boardStop"."tripId" = "trips".id
            WHERE
              tickets."userId" = :userId
            ORDER BY "trips"."routeId", "tickets"."id" DESC) AS a
          ORDER BY "ticketId" DESC
          LIMIT :limit
          `, {
            type: db.QueryTypes.SELECT,
            replacements: {
              userId: request.auth.credentials.userId,
              limit: 5,
            }
          }))

        // Fetch the relevant routes and index them by id
        const utcMidnightOfSameDay = d => new Date(
          Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
        const routeIdsAndStops = await Promise.all(recentStopLatLngPairs.map(fetchRouteIds))
        const actualRecentRoutesIds = _.keyBy(recentStopLatLngPairs.map(rs => rs.routeId))
        const similarRoutesById = _(await m.Route.findAll({
          where: {
            id: {$in: _.uniqBy(_.flatten(routeIdsAndStops.map(ris => ris[0])))},
          },
          include: [{
            separate: true,
            model: m.Trip,
            where: [{
              date: {
                $gte: utcMidnightOfSameDay(request.query.startDateTime),
                $lte: utcMidnightOfSameDay(request.query.endDateTime),
              }
            }],
            include: [{
              model: m.TripStop,
              include: [m.Stop]
            }]
          }]
        }))
          .map(r => r.toJSON())
          .keyBy('id')
          .value()

        const bestStop = function (trips, point, f) {
          return _(trips)
            .map(t => t.tripStops.filter(f).map(ts => ts.stop))
            .flatten()
            .uniqBy('id')
            .sortBy(s => latLngDistance(
              [s.coordinates.coordinates[1], s.coordinates.coordinates[0]],
              [point.coordinates[1], point.coordinates[0]],
            ))
            .value()[0]
        }

        const routesWithBestStops = routeIdsAndStops.map(([rids, board, alight]) => {
          return rids.map(rid => {
            const route = similarRoutesById[rid]
            return {
              ...route,
              boardStopStopId: bestStop(route.trips, board, ts => ts.canBoard).id,
              alightStopStopId: bestStop(route.trips, alight, ts => ts.canAlight).id,
              isRecentlyBooked: !!actualRecentRoutesIds[route.id],
            }
          })
        })

        reply(_.flatten(routesWithBestStops))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: 'GET',
    path: "/routes/report",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        query: Joi.object({
          startDate: Joi.date(),
          endDate: Joi.date(),
          tags: Joi.array().items(Joi.string()),
          transportCompanyId: Joi.number().integer(),

          order: Joi.any().valid(['desc', 'asc']).default('asc'),
          orderBy: Joi.string(),

          perPage: Joi.number().integer().default(20).min(1),
          page: Joi.number().integer().default(1).min(1),
          format: Joi.any().valid(['csv', 'json']).default('json')
        })
      },

      async handler (request, reply) {
        try {
          var db = getDB(request)
          var m = getModels(request)
          var routesQuery = {
            where: {
              $and: [],
            },
            attributes: {},
            include: [
              {
                model: m.TransportCompany,
                attributes: {exclude: ['logo', 'features', 'terms']}
              },
              m.IndicativeTrip]
          }

          var literals = {
            startDate: '(SELECT MIN(trips."date") FROM trips WHERE trips."routeId" = "route"."id")',
            endDate: '(SELECT MAX(trips."date") FROM trips WHERE trips."routeId" = "route"."id")',
          }
          literals = _.mapValues(literals, v => db.literal(v))

          // Additional attributes for reports
          routesQuery.attributes.include = [
            [literals.startDate, 'startDate'],
            [literals.endDate, 'endDate'],
          ]

          // Query parameters
          if (request.query.tags && request.query.tags.length > 0) {
            routesQuery.where.tags = {
              $contains: request.query.tags
            }
          }
          if (request.query.startDate) {
            // routesQuery.where.startDate = {$gte: request.query.startDate};
            routesQuery.where.$and.push(
              db.where(literals.endDate, '>', request.query.startDate)
            )
          }
          if (request.query.endDate) {
            // routesQuery.where.startDate = {$gte: request.query.startDate};
            routesQuery.where.$and.push(
              db.where(literals.startDate, '<', request.query.endDate)
            )
          }
          if (request.query.transportCompanyId) {
            assert(request.query.transportCompanyId in request.auth.credentials.permissions)
            routesQuery.where.transportCompanyId = request.query.transportCompanyId
          } else {
            routesQuery.where.transportCompanyId = {$in: Object.keys(request.auth.credentials.permissions)}
          }

          routesQuery.order = []
          if (request.query.orderBy) {
            if (request.query.orderBy in m.Route.attributes) {
              routesQuery.order.push([request.query.orderBy, request.query.order])
            } else if (request.query.orderBy in m.IndicativeTrip.attributes) {
              routesQuery.order.push([m.IndicativeTrip, request.query.orderBy, request.query.order])
            } else if (request.query.orderBy in literals) {
              routesQuery.order.push([literals[request.query.orderBy], request.query.order])
            }
          } else {
            routesQuery.order.push(['label', 'ASC'])
          }
          routesQuery.order.push(['id', 'ASC'])

          if (request.query.format === 'json') {
            routesQuery.limit = request.query.perPage
            routesQuery.offset = (request.query.page - 1) * request.query.perPage
            var {rows, count} = await m.Route.findAndCountAll(routesQuery)
            reply({
              rows: rows,
              perPage: request.query.perPage,
              page: request.query.page,
              count: count,
            })
          } else if (request.query.format === 'csv') {
            throw new InvalidArgumentError('csv reports are not supported')
          }
        } catch (err) {
          defaultErrorHandler(reply)(err)
        }
      },
    },

  })

  server.route({
    method: "GET",
    path: "/routes/{id}/features",
    config: {
      tags: ["api"],
      description: `Renders the important notes as HTML from Markdown`,
      validate: {
        params: {
          id: Joi.number().integer().required()
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var routes = await m.Route.findById(request.params.id, {
          attributes: { include: ["features"] }
        })
        if (routes == null) {
          return reply(Boom.notFound(request.params.id))
        }
        if (!routes.features) {
          return reply("")
        }
        var reader = new commonmark.Parser({safe: true})
        var writer = new commonmark.HtmlRenderer({safe: true})
        var parsed = reader.parse(routes.features)
        return reply(writer.render(parsed))
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  server.route({
    method: "POST",
    path: "/liteRoutes/subscriptions",
    config: {
      auth: {access: {scope: ['user']}},
      validate: {
        payload: Joi.object({
          routeLabel: Joi.string().required()
        })
      },
      tags: ["api"]
    },

    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var route = await m.Route.findOne({
          where: {label: request.payload.routeLabel, tags: {$contains: ['lite']}}
        })
        if (!route) {
          return reply(Boom.badRequest("This is not a lite route"))
        }
        var subscriptionInst = await m.Subscription.findOrCreate({
          where: {
            userId: request.auth.credentials.userId,
            routeLabel: request.payload.routeLabel,
          },
          defaults: {
            userId: request.auth.credentials.userId,
            routeLabel: request.payload.routeLabel,
            status: "valid"
          }
        })
        // when user unsubscribe it before
        if (subscriptionInst[0].status === "invalid") {
          await subscriptionInst[0].update({
            status: "valid"
          })
        }
        reply(subscriptionInst[0].toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/liteRoutes/subscriptions",
    config: {
      auth: {access: {scope: ['user']}},
      tags: ["api"]
    },

    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var subscriptions = await m.Subscription.findAll({
          where: {
            userId: request.auth.credentials.userId,
            status: "valid"
          },
        })
        reply(subscriptions.map(s => s.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "DELETE",
    path: "/liteRoutes/subscriptions/{routeLabel}",
    config: {
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          routeLabel: Joi.string().required()
        }
      },
      tags: ["api"]
    },

    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var route = await m.Route.findOne({
          where: {label: request.params.routeLabel,
            tags: {$contains: ['lite']}}
        })
        if (!route) {
          return reply(Boom.badRequest("This is not a lite route"))
        }
        var subscription = await m.Subscription.findOne({
          where: {
            userId: request.auth.credentials.userId,
            routeLabel: request.params.routeLabel
          }
        })
        if (!subscription) {
          return reply(Boom.notFound(request.params.routeLabel))
        }
        await subscription.update({
          status: "invalid"
        })
        reply(subscription.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}

register.attributes = {
  name: "endpoint-routes"
}
