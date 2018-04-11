const _ = require("lodash")
const moment = require("moment")
const { getModels, getDB } = require("../util/common")

const stringDate = d => d && moment(d).format(moment.HTML5_FMT.DATE)

let currentRoutesPromise = null

const cachedFetchRoutes = request => {
  if (!currentRoutesPromise) {
    setTimeout(
      () => (currentRoutesPromise = null),
      process.env.ROUTES_REFRESH_INTERVAL || 300000
    )
    currentRoutesPromise = fetchAllRoutes(request).then(routes => {
      for (let route of routes) {
        route._cached = true
      }
      return routes
    })
  }
  return currentRoutesPromise
}

const fetchAllRoutes = request => {
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
    },
  })
}

const filterCached = (routes, request) => {
  return routes
    .filter(r => {
      return (
        (!request.query.transportCompanyId ||
          r.transportCompanyId === request.query.transportCompanyId) &&
        (!request.query.tags ||
          _.every(
            request.query.tags,
            tag => r.tags && r.tags.find(t => t === tag)
          )) &&
        (!request.query.label || r.label === request.query.label)
      )
    })
    .map(r => {
      const base = _.omit(r, ["path", "trips"])

      if (request.query.includePath) {
        base.path = r.path
      }
      if (request.query.includeTrips) {
        base.trips = r.trips

        if (request.query.endDate) {
          const compare = stringDate(request.query.endDate)
          base.trips = base.trips.filter(
            t => t.date.toISOString().substr(0, 10) <= compare
          )
        }
        if (request.query.limitTrips) {
          base.trips = base.trips.slice(0, request.query.limitTrips)
        }
      }
      return base
    })
    .filter(r => !request.query.includeTrips || r.trips.length > 0)
}

const uncachedFetchRoutes = async request => {
  const m = getModels(request)
  const db = getDB(request)
  const routeQuery = {
    where: undefined,
    include: [],
    attributes: {
      exclude: [],
    },
  }
  // additional options
  if (request.query.transportCompanyId) {
    routeQuery.where = routeQuery.where || {}
    routeQuery.where.transportCompanyId = request.query.transportCompanyId
  }
  if (request.query.tags && request.query.tags.length > 0) {
    routeQuery.where = routeQuery.where || {}
    routeQuery.where.tags = { $contains: request.query.tags }
  }
  if (request.query.companyTags && request.query.companyTags.length > 0) {
    routeQuery.where = routeQuery.where || {}
    routeQuery.where.companyTags = { $contains: request.query.companyTags }
  }
  if (request.query.label) {
    routeQuery.where = routeQuery.where || {}
    routeQuery.where.label = request.query.label
  }
  // Filter by dates
  if (
    (request.query.startDate || request.query.endDate) &&
    !request.query.includeTrips
  ) {
    routeQuery.where = routeQuery.where || {}
    routeQuery.where.$and = routeQuery.where.$and || []

    let startDateExpr =
      request.query.startDate && request.query.startDate.toISOString()
    let endDateExpr =
      request.query.endDate && request.query.endDate.toISOString()

    routeQuery.where.$and.push([
      `"route".id IN (SELECT "routeId" FROM "trips" INNER JOIN "tripStops"
            ON "trips"."id" = "tripStops"."tripId"
            WHERE
              (${db.escape(
                startDateExpr
              )} IS NULL OR "tripStops"."time" >= ${db.escape(startDateExpr)})
              AND (${db.escape(
                endDateExpr
              )} IS NULL OR "tripStops"."time" < ${db.escape(endDateExpr)})
          )`,
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
    const routeDatesById = _.keyBy(routeDates, "routeId")
    routes.forEach(route => {
      route.dates = routeDatesById[route.id] || {}
    })
  }

  if (request.query.includeTrips) {
    const startDateQuery = request.query.startDate
      ? `"trips".date >= :startDate`
      : "1=1"

    const endDateQuery = request.query.endDate
      ? `"trips".date <= :endDate`
      : "1=1"

    const tripQueries = []

    for (let i = 0; i < routes.length; i += 10) {
      const routeIdBatch = routes.slice(i, i + 10).map(r => r.id)
      const tripIdsQuery = routeIdBatch
        .map(
          routeId =>
            `
          (SELECT "id" FROM "trips"
          WHERE
          trips."routeId" = (${routeId})
          AND ${startDateQuery}
          AND ${endDateQuery}
          ORDER BY "date"
          LIMIT :limitTrips)
        `
        )
        .join(" UNION ")
      const tripIdsBatch = await db.query(tripIdsQuery, {
        // eslint-disable-line no-await-in-loop
        replacements: {
          startDate: stringDate(request.query.startDate),
          endDate: stringDate(request.query.endDate),
          limitTrips: request.query.limitTrips,
        },
        raw: true,
        type: db.QueryTypes.SELECT,
      })
      tripQueries.push(
        m.Trip.findAll({
          where: {
            id: { $in: tripIdsBatch.map(t => t.id) },
          },
          include: [
            {
              model: m.TripStop,
              attributes: { exclude: ["createdAt", "updatedAt"] },
              include: [
                {
                  model: m.Stop,
                  attributes: { exclude: ["createdAt", "updatedAt"] },
                },
              ],
            },
          ],
          order: [["id"], [m.TripStop, "time"]],
          attributes: { exclude: ["createdAt", "updatedAt"] },
        })
      )
    }

    const trips = await Promise.all(tripQueries).then(_.flatten)

    const tripsByRouteId = _.groupBy(trips, "routeId")

    return routes.filter(route => tripsByRouteId[route.id]).map(route => ({
      ...route,
      trips: _.sortBy(tripsByRouteId[route.id].map(t => t.toJSON()), "date"),
    }))
  } else {
    return routes
  }
}

module.exports = {
  cachedFetchRoutes,
  uncachedFetchRoutes,
  filterCached,
}
