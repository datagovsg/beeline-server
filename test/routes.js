/* eslint no-await-in-loop: 0 */

const Lab = require("lab")
export const lab = Lab.script()

const { expect } = require("code")
const server = require("../src/index.js")

const testData = require("./test_data")
const {db, models} = require("../src/lib/core/dbschema")()
const leftPad = require('left-pad')
const {loginAs, randomSingaporeLngLat, randomEmail} = require("./test_common")

import {toWGS} from "../src/lib/util/svy21"
import _ from 'lodash'
import querystring from "querystring"

lab.experiment("Route manipulation", function () {
  let testName = "Name for Testing"
  let updatedTestName = "Updated name for Testing"

  let cleanup = () => {
    return models.Route.destroy({
      where: {
        name: testName,
      },
    }).then(() => {
      return models.Route.destroy({
        where: {
          name: updatedTestName,
        },
      })
    })
  }

  const stringDate = d => d && [
    leftPad(d.getFullYear(), 4, '0'),
    leftPad(d.getMonth() + 1, 2, '0'),
    leftPad(d.getDate(), 2, '0'),
  ].join('-')

  let routeId = null
  let routeInfo = {
    name: testName,
    from: "Testing Route From",
    to: "Testing Route To",
    path: JSON.stringify({testing: "testing"}),
    features: "* feature 1",
    label: "Test1",
  }
  let updatedRouteInfo = {
    id: 123456,
    name: updatedTestName,
    from: "XTesting Route From",
    to: "XTesting Route To",
    path: JSON.stringify({testing: "xtesting"}),
    features: "* feature 1",
    label: "Test1",
  }

  let [transportCompany, transportCompany2, route] = []

  lab.before({timeout: 10000}, async function () {
    transportCompany = await models.TransportCompany.create({})
    routeInfo.transportCompanyId = transportCompany.id
    updatedRouteInfo.transportCompanyId = transportCompany.id
    transportCompany2 = await models.TransportCompany.create({})


    // Create stops
    const stopInstances = await Promise.all(
      _.range(0, 5).map((i) => models.Stop.create({
        description: `Test Stop ${i + 1}`,
        coordinates: {
          type: "Point",
          coordinates: randomSingaporeLngLat(),
        },
      }))
    )

    // Create the routes
    const populateRoute = async (routeOptions, dates, tripOptions) => {
      const route = await models.Route.create({
        ...routeInfo,
        ...routeOptions,
      })
      await Promise.all(dates.map(dt => models.Trip.create({
        ...tripOptions,
        routeId: route.id,
        price: '10.01',
        capacity: 10,
        date: dt,
        bookingInfo: {
          windowType: 'stop',
          windowSize: 0,
        },
        transportCompanyId: transportCompany.id,
        // Objective: generate the times like so:
        // 6, 9, 7, 10, 8
        // so we can test that they are returned sorted
        tripStops: stopInstances.map((s, i) => ({
          time: `${dt}T${leftPad(6 + ((i * 3) % 5), 2, '0')}:00:00+0800`,
          stopId: s.id,
          canBoard: true,
          canAlight: true,
        })),
      }, {include: [models.TripStop]})))
      return route
    }

    route = await populateRoute({
      tags: ['public'],
      companyTags: ['banana'],
      label: 'L1',
    }, [
      '2015-12-01',
      '2016-01-01',
      '2016-06-01',
      '2017-01-01',
    ], {})

    await populateRoute({
      tags: ['lite'],
      label: 'L1',
    }, [
      '2015-12-01',
      '2016-01-01',
      '2016-06-01',
      '2017-01-01',
    ], {})
    await populateRoute({
      tags: ['lite'],
      label: 'L1',
    }, [
      '2015-12-03',
      '2016-01-03',
      '2016-06-03',
      '2017-01-03',
    ], {})

    await populateRoute({
      tags: ['lite'],
      label: 'L2',
    }, [
      '2015-12-01',
      '2016-01-01',
      '2016-06-01',
      '2017-01-01',
    ], {})

    /* This should be cacheable */
    await populateRoute({
      tags: ['public'],
      label: 'R2',
    }, [
      Date.now() + 2 * 24 * 60 * 60 * 1000,
      Date.now() + 3 * 24 * 60 * 60 * 1000,
      Date.now() + 1 * 24 * 60 * 60 * 1000,
      Date.now() + 4 * 24 * 60 * 60 * 1000,
    ].map(ts => stringDate(new Date(ts))), {})
  })
  lab.after(async function () {
    await models.Trip.destroy({where: {routeId: route.id}})
    await models.Route.destroy({where: {transportCompanyId: transportCompany.id}})
    await transportCompany.destroy()
    await transportCompany2.destroy()
  })

  lab.test("List routes", {timeout: 15000}, async function () {
    let response = await server.inject({
      method: 'GET',
      url: '/routes?includeDates=true',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    for (let route of response.result) {
      expect(route.dates).instanceof(Object)
      if (route.dates.lastDate) {
        expect(route.dates.lastDate).least(route.dates.firstDate)
      }
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?includeTrips=true',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    for (let route of response.result) {
      expect(route.trips).instanceof(Array)
      for (let trip of route.trips) {
        // Ensure tripStops are sorted by time
        for (let i = 1; i < trip.tripStops.length; i++) {
          expect(trip.tripStops[i].time).least(trip.tripStops[i - 1].time)
        }
      }
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?includeTrips=true&startDate=2016-01-01',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).above(1)
    for (let route of response.result) {
      expect(route.trips).not.empty()
      for (let trip of route.trips) {
        expect(new Date(trip.date).getTime()).least(new Date('2016-01-01').getTime())
      }
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?includeTrips=true&endDate=2016-12-01',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).above(1)
    for (let route of response.result) {
      expect(route.trips).not.empty()
      for (let trip of route.trips) {
        expect(new Date(trip.date).getTime()).most(new Date('2016-12-01').getTime())
      }
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?tags=["public"]',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    for (let route of response.result) {
      expect(route.tags.indexOf('public')).not.equal(-1)
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?companyTags=["banana"]',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    for (let route of response.result) {
      expect(route.companyTags.indexOf('banana')).not.equal(-1)
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?includeTrips=true',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    for (let route of response.result) {
      expect(route.trips).exist()
      for (let trip of route.trips) {
        expect(trip.availability).exists()
      }
    }

    response = await server.inject({
      method: 'GET',
      url: '/routes?tags=["lite"]&label=L1',
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(2)
    for (let route of response.result) {
      expect(route.label).equal('L1')
      expect(route.tags.indexOf('lite')).not.equal(-1)
    }
  })

  lab.test("List routes (today)", {timeout: 15000}, async function () {
    let response = await server.inject({
      method: 'GET',
      url: '/routes?' + querystring.stringify({
        includeTrips: 'true',
        startDate: stringDate(new Date()),
      }),
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).above(1)
    expect(response.result.find(r => r.label === 'R2')).exist()
    for (let route of response.result) {
      expect(route.trips).instanceof(Array)
      expect(route._cached).true()
    }

    // Test tags, test label
    await server.inject({
      method: 'GET',
      url: '/routes?' + querystring.stringify({
        includeTrips: 'true',
        tags: JSON.stringify(['public']),
        label: 'R2',
        startDate: stringDate(new Date()),
      }),
    })
    expect(response.statusCode).equal(200)
    expect(response.result.length).least(1)
    expect(response.result.find(r => r.label === 'R2')).exist()
    for (let route of response.result) {
      expect(route.trips).instanceof(Array)
      expect(route._cached).true()
    }
  })


  lab.test("Get route", {timeout: 10000}, async function () {
    let response = await server.inject({
      method: 'GET',
      url: `/routes/${route.id}?includeDates=true`,
    })
    expect(response.statusCode).equal(200)
    expect(response.result.dates).instanceof(Object)
    expect(response.result.dates.lastDate).least(response.result.dates.firstDate)

    response = await server.inject({
      method: 'GET',
      url: `/routes/${route.id}?includeTrips=true`,
    })
    expect(response.statusCode).equal(200)
    expect(response.result.trips).not.empty()

    response = await server.inject({
      method: 'GET',
      url: `/routes/${route.id}?includeTrips=true&startDate=2016-01-01`,
    })
    expect(response.statusCode).equal(200)
    for (let trip of response.result.trips) {
      expect(new Date(trip.date)).least(new Date('2016-01-01').getTime())
    }

    response = await server.inject({
      method: 'GET',
      url: `/routes/${route.id}?includeTrips=true&endDate=2016-12-01`,
    })
    expect(response.statusCode).equal(200)
    for (let trip of response.result.trips) {
      expect(new Date(trip.date)).most(new Date('2016-12-01').getTime())
    }

    response = await server.inject({
      method: 'GET',
      url: `/routes/${route.id}?includeTrips=true`,
    })
    expect(response.statusCode).equal(200)
    for (let trip of response.result.trips) {
      expect(trip.availability).exist()
    }
  })

  lab.test("CRUD routes", {timeout: 10000}, async function () {
    const superadminAuthHeaders = {
      authorization: "Bearer " + (await loginAs('superadmin')).result.sessionToken,
    }

    const authHeaders = {
      authorization: 'Bearer ' + (await loginAs("admin", {
        transportCompanyId: transportCompany.id,
        permissions: ['manage-routes'],
      })).result.sessionToken,
    }

    await Promise.resolve()
      // CREATE
      .then(() => {
        return server.inject({
          method: "POST",
          url: "/routes",
          payload: _.defaults({features: ''}, routeInfo),
          headers: superadminAuthHeaders,
        })
      })
      .then((resp) => expect(resp.statusCode).equal(200))
      .then(() => {
        return server.inject({
          method: "POST",
          url: "/routes",
          payload: routeInfo,
          headers: superadminAuthHeaders,
        })
      })
      .then((resp) => {
        expect(resp.statusCode).to.equal(200)
        expect(resp.result).to.include("id")

        expect(resp.result).to.include(routeInfo)
        routeId = resp.result.id
      })
      // READ
      .then(() => {
        return server.inject({
          method: "GET",
          url: "/routes/" + routeId,
        })
      })
      .then((resp) => {
        // default scope not include features
        delete routeInfo.features
        expect(resp.statusCode).to.equal(200)
        expect(resp.result).to.include(routeInfo)
      })
      // UPDATE
      .then(() => {
        return server.inject({
          method: "PUT",
          url: "/routes/" + routeId,
          headers: superadminAuthHeaders,
          payload: _.defaults({features: ''}, updatedRouteInfo),
        })
      })
      .then((resp) => expect(resp.statusCode).equal(200))
      .then(() => {
        return server.inject({
          method: "PUT",
          url: "/routes/" + routeId,
          headers: superadminAuthHeaders,
          payload: updatedRouteInfo,
        })
      })
      .then((resp) => {
        expect(resp.statusCode).to.equal(200)
        delete updatedRouteInfo.id
        expect(resp.result).to.include(updatedRouteInfo)
      })
      .then(() => {
        return server.inject({
          method: "GET",
          url: "/routes/" + routeId,
        })
      })
      .then((resp) => {
        delete updatedRouteInfo.features
        expect(resp.result).to.include(updatedRouteInfo)
      })
      // DELETE
      .then(() => {
        return server.inject({
          method: "DELETE",
          url: "/routes/" + routeId,
          headers: authHeaders,
        })
      })
      .then((resp) => {
        expect(resp.statusCode).to.equal(200)
      })
      .then(() => {
        return server.inject({
          method: "GET",
          url: "/routes/" + routeId,
        })
      })
      .then((resp) => {
        expect(resp.statusCode).to.equal(404)
      })
      .then(cleanup, cleanup)
  })


  lab.test("Get route with indicative trip", async function () {
    let routeInstance = await models.Route.create(routeInfo)
    let now = new Date()

    let stopInstances = [
      await models.Stop.create({coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}),
      await models.Stop.create({coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}),
      await models.Stop.create({coordinates: {type: "Point", coordinates: toWGS([1000, 2010])}, description: "Some stop 2"}),
    ]

    let trips = [{
      routeId: routeInstance.id,
      price: 5.00,
      capacity: 10,
      seatsAvailable: 10,
      status: "ACTIVE",
      transportCompanyId: transportCompany.id,
      driverId: null,
      vehicleId: null,
      date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 2)),

      tripStops: [
        {stopId: stopInstances[0].id, canBoard: true, canAlight: false,
          time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 8, 0, 0)},
        {stopId: stopInstances[1].id, canBoard: false, canAlight: true,
          time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 9, 0, 0)},
      ],
    }, {
      routeId: routeInstance.id,
      price: 10.00,
      capacity: 10,
      seatsAvailable: 10,
      status: "ACTIVE",
      transportCompanyId: transportCompany.id,
      driverId: null,
      vehicleId: null,
      date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 3)),

      tripStops: [
        {stopId: stopInstances[0].id, canBoard: true, canAlight: false,
          time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 8, 0, 0)},
        {stopId: stopInstances[1].id, canBoard: true, canAlight: false,
          time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 8, 10, 0)},
        {stopId: stopInstances[2].id, canBoard: false, canAlight: true,
          time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 9, 0, 0)},
      ],
    }]

    let tripInstances = await Promise.all(trips.map(trInfo => (
      models.Trip.create(trInfo, {include: [models.TripStop]})
    )))

    let response = await server.inject({
      method: 'GET',
      url: `/routes/${routeInstance.id}?includeIndicative=true`,
    })
    expect(response.statusCode).equal(200)
    expect(response.result).to.include('indicativeTrip')

    expect(response.result.indicativeTrip.nextTripId).to.equal(tripInstances[0].id)
    expect(response.result.indicativeTrip.lastTripId).to.equal(tripInstances[1].id)

    const intervalToTimeSinceMidnight = interval => {
      let hours = (interval.hours || 0) + 8
      let minutes = interval.minutes || 0
      return hours * 3600000 + minutes * 60000
    }

    expect(intervalToTimeSinceMidnight(response.result.indicativeTrip.nextStartTime))
      .to.equal(intervalToTimeSinceMidnight({hours: 0, minutes: 0}))
    expect(intervalToTimeSinceMidnight(response.result.indicativeTrip.lastStartTime))
      .to.equal(intervalToTimeSinceMidnight({hours: 0, minutes: 0}))

    expect(intervalToTimeSinceMidnight(response.result.indicativeTrip.nextEndTime))
      .to.equal(intervalToTimeSinceMidnight({hours: 1, minutes: 0}))
    expect(intervalToTimeSinceMidnight(response.result.indicativeTrip.lastEndTime))
      .to.equal(intervalToTimeSinceMidnight({hours: 1, minutes: 0}))

    expect(response.result.indicativeTrip.nextStartDescription).to.equal(stopInstances[0].description)
    expect(response.result.indicativeTrip.lastStartDescription).to.equal(stopInstances[0].description)

    expect(response.result.indicativeTrip.nextEndDescription).to.equal(stopInstances[1].description)
    expect(response.result.indicativeTrip.lastEndDescription).to.equal(stopInstances[2].description)

    await routeInstance.destroy()
    await Promise.all(tripInstances.map(tr => tr.destroy()))
  })

  lab.test("Get availability -- date/timezone test", async function () {
    let routeInst = await models.Route.create(routeInfo)
    let trips = testData.trips

    trips = trips.map((tr) => _.extend({routeId: routeInst.id}, tr))
    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)

    let resp = await server.inject({
      url: "/routes/" + routeInst.id + "?" +
                    querystring.stringify({
                      startDate: new Date(2016, 1 /* FEBRUARY */, 1).toISOString(),
                      endDate: new Date(2016, 1 /* FEBRUARY */, 2).toISOString(),
                      includeTrips: true,
                    }),
      method: "GET",
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("trips")
    expect(resp.result.trips.length).to.equal(1)

    for (let trip of trips) {
      await Promise.all(
        trip.tripStops.map(ts => ts.destroy())
      )
    }
    await Promise.all(
      trips.map((tr) => tr.destroy())
    )
    await Promise.all([
      routeInst.destroy(),
    ])
  })
  lab.test("Get availability", async function () {
    let routeInst = await models.Route.create(routeInfo)
    let trips = testData.trips

    trips = trips.map((tr) => _.extend({routeId: routeInst.id}, tr))
    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)

    // create test account
    let testAccount = await models.Account.create({
      name: "Unit test account (FAKE)",
    })
    let testUser = await models.User.create(testData.users[0])

    // create some tickets
    let ticketTransaction = {
      committed: true,
      description: "Test entry",
      transactionItems: [
        {
          itemType: "ticketSale",
          ticketSale: {
            status: "valid",
            boardStopId: trips[0].tripStops[0].id,
            alightStopId: trips[0].tripStops[1].id,
            userId: testUser.id,
          },
          credit: 0,
        },
        {
          itemType: "ticketSale",
          ticketSale: {
            status: "valid",
            boardStopId: trips[1].tripStops[0].id,
            alightStopId: trips[1].tripStops[2].id,
            userId: testUser.id,
          },
          credit: 0,
        },
        {
          itemType: "ticketSale",
          ticketSale: {
            status: "pending",
            boardStopId: trips[0].tripStops[2].id,
            alightStopId: trips[0].tripStops[1].id,
            userId: testUser.id,
          },
          credit: 0,
        },
        {
          itemType: "account",
          itemId: testAccount.id,
          debit: 0,
        },
      ],
    }

    let transactionInst = await models.Transaction.create(ticketTransaction, {
      include: [{
        model: models.TransactionItem,
        include: [
          {model: models.Ticket, as: "ticketSale"},
          {model: models.Account, as: "account"},
        ],
      }],
    })

    let resp = await server.inject({
      url: "/routes/" + routeInst.id + "?" +
                querystring.stringify({
                  startDate: new Date(2016, 1 /* 1 = FEBRUARY */, 1).toISOString(),
                  endDate: new Date(2016, 1 /* 1 = FEBRUARY */, 20).toISOString(),
                  includeTrips: true,
                }),
      method: "GET",
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("trips")

    const findTrip = trip => resp.result.trips.find((tr) => tr.id === trip.id)

    // check bookings
    expect(parseInt(findTrip(trips[0]).availability.seatsAvailable))
      .to.equal(trips[0].capacity - 2)

    expect(parseInt(findTrip(trips[0]).availability.seatsBooked))
      .to.equal(2)

    expect(parseInt(findTrip(trips[1]).availability.seatsAvailable))
      .to.equal(trips[1].capacity - 1)

    expect(parseInt(findTrip(trips[2]).availability.seatsAvailable))
      .to.equal(trips[2].capacity)

    // Check that seatsAvailable + seatsBooked == seatsTotal
    // Check seatsTotal == capacity
    for (let tr of resp.result.trips) {
      expect(tr.availability.seatsTotal)
        .to.equal(tr.availability.seatsAvailable + tr.availability.seatsBooked)

      expect(tr.availability.seatsTotal)
        .to.equal(trips.filter((t) => t.id === tr.id)[0].capacity)
    }

    for (let ti of transactionInst.transactionItems) {
      if (ti.ticketSale) {
        await ti.ticketSale.destroy()
      }
    }

    await Promise.all(
      trips.map((tr) => tr.destroy())
    )
    await Promise.all([
      routeInst.destroy(),
      testAccount.destroy(),
      testUser.destroy(),
    ])
  })

  lab.test("Search by Lat Lon #2", async function () {
    // elements of testInstances will be destroyed at the end
    let testInstances = []

    let routes = [
      await models.Route.create(routeInfo),
      await models.Route.create(routeInfo),
    ]
    testInstances.push(routes[0])
    testInstances.push(routes[1])
    let trips = [
      {
        routeId: routes[0].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
      {
        routeId: routes[1].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10000, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40000, 20000])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
    ]

    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)
    for (let tr of trips) {
      testInstances.push(tr)
    }

    // check that a reasonable result is returned
    let startLatLng = toWGS([10100, 19600]) // nearby trip #2 stop #1
    let endLatLng = toWGS([40200, 20200]) // nearby trip #2 stop #2
    let response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)

    // ensure that the stops are returned in sorted order
    for (let route of response.result) {
      for (let trip of route.trips) {
        for (let i = 0; i < trip.tripStops.length - 1; i++) {
          let thisStop = trip.tripStops[i]
          let nextStop = trip.tripStops[i + 1]

          expect(new Date(thisStop.time).getTime())
            .to.be.most(new Date(nextStop.time).getTime())
        }
      }
    }

    let routeIds = response.result.map(r => r.id)
    expect(routeIds).to.not.include(routes[0].id)
    expect(routeIds).to.include(routes[1].id)

    // check that a reasonable result is returned
    startLatLng = toWGS([1100, 1200]) // nearby trip #1 stop #1
    endLatLng = toWGS([4200, 2200]) // nearby trip #1 stop #2
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)
    routeIds = response.result.map(r => r.id)
    expect(routeIds).to.not.include(routes[1].id)
    expect(routeIds).to.include(routes[0].id)

    try {
      testInstances = testInstances.map((t) => t.destroy())
      await Promise.all(testInstances)
    } catch (err) {
      console.error(err.stack)
    }
  })

  lab.test("Search by Lat Lon #3 (missing start or missing end)", async function () {
    // elements of testInstances will be destroyed at the end
    let testInstances = []

    let routes = [
      await models.Route.create(routeInfo),
      await models.Route.create(routeInfo),
    ]

    testInstances.push(routes[0])
    testInstances.push(routes[1])

    let trips = [
      {
        routeId: routes[0].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
      {
        routeId: routes[1].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10000, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40000, 20000])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
    ]

    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)
    for (let tr of trips) {
      testInstances.push(tr)
    }

    // missing start
    let startLatLng = toWGS([10100, 19600]) // nearby trip #2 stop #1
    let endLatLng = toWGS([40200, 20200]) // nearby trip #2 stop #2
    let response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        // startLat: startLatLng[1],
        // startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)
    expect(_.some(response.result, r => r.id === routes[1].id)).true()
    expect(_.some(response.result, r => r.id === routes[0].id)).false()

    // check that a reasonable result is returned
    startLatLng = toWGS([10100, 19600]) // nearby trip #2 stop #1
    endLatLng = toWGS([40200, 20200]) // nearby trip #2 stop #2
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        // endLat: endLatLng[1],
        // endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)
    expect(_.some(response.result, r => r.id === routes[1].id)).true()
    expect(_.some(response.result, r => r.id === routes[0].id)).false()
  })

  lab.test("Search by Lat Lon", async function () {
    // elements of testInstances will be destroyed at the end
    let testInstances = []
    let routeInst = await models.Route.create(routeInfo)
    testInstances.push(routeInst)
    let trips = [
      {
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2010])}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2030])}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
      {
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-02T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2010])}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2030])}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-02T08:00:00+0800"},
        ],
      },
      {
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-03T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2010])}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([1000, 2030])}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([4000, 2040])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-03T08:00:00+0800"},
        ],
      },
    ]

    trips = trips.map((tr) => _.extend({routeId: routeInst.id}, tr))
    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)
    for (let tr of trips) {
      testInstances.push(tr)
    }

    // check that a reasonable result is returned
    let startLatLng = toWGS([800, 1800]) // 282.8 m away from stop # 1
    let endLatLng = toWGS([3900, 2040]) // 100 m away from stop # 4
    let response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("2016-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)
    let matching = response.result.filter((x) => x.id === routeInst.id)
    expect(matching.length).to.equal(1)
    expect(Math.abs(matching[0].distanceToQuery - 382.8)).to.be.below(1)
    expect(Math.abs(matching[0].timeDifference - 0)).to.be.below(1)

    // ensure that the stops are returned in sorted order
    for (let route of response.result) {
      for (let trip of route.trips) {
        for (let i = 0; i < trip.tripStops.length - 1; i++) {
          let thisStop = trip.tripStops[i]
          let nextStop = trip.tripStops[i + 1]

          expect(new Date(thisStop.time).getTime())
            .to.be.most(new Date(nextStop.time).getTime())
        }
      }
    }

    // there should be no results if query is beyond the date of trips
    // after the trips
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        startTime: new Date("2016-02-04T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-10T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.result
      .filter((x) => x.id === routeInst.id)
      .length).to.equal(0)

    // there should be no results if query is beyond the date of trips
    // before the trips
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        startTime: new Date("2016-01-04T00:00:00+0800").toISOString(),
        endTime: new Date("2016-01-10T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.result
      .filter((x) => x.id === routeInst.id)
      .length).to.equal(0)

    // TODO: check that the trips are in sorted order!
    try {
      testInstances = testInstances.map((t) => t.destroy())
      await Promise.all(testInstances)
    } catch (err) {
      console.error(err.stack)
    }
  })

  lab.test("Search by Lat Lon #3 (with tags)", async function () {
    // elements of testInstances will be destroyed at the end
    let testInstances = []
    let routes = [
      await models.Route.create(_.assign({
        tags: ['A'],
      }, routeInfo)),
      await models.Route.create(_.assign({
        tags: null,
      }, routeInfo)),
    ]
    testInstances.push(routes[0])
    testInstances.push(routes[1])
    let trips = [
      {
        routeId: routes[0].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10020, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40030, 20020])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
      {
        routeId: routes[1].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10000, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40000, 20000])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
    ]

    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)
    for (let tr of trips) {
      testInstances.push(tr)
    }

    // Tag with A
    let startLatLng = toWGS([10100, 19600]) // Nearby to both stops
    let endLatLng = toWGS([40200, 20200])
    let response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
        tags: JSON.stringify(['A']),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)

    let routeIds = response.result.map(r => r.id)
    expect(routeIds).to.include(routes[0].id)
    expect(routeIds).to.not.include(routes[1].id)

    // Tag without A
    startLatLng = toWGS([10100, 19600]) // Nearby to both stops
    endLatLng = toWGS([40200, 20200])
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)

    routeIds = response.result.map(r => r.id)
    expect(routeIds).to.include(routes[0].id)
    expect(routeIds).to.include(routes[1].id)

    try {
      testInstances = testInstances.map((t) => t.destroy())
      await Promise.all(testInstances)
    } catch (err) {
      console.error(err.stack)
    }
  })

  lab.test("Search by Lat Lon #4 (with transportCompanyId)", async function () {
  // elements of testInstances will be destroyed at the end
    let testInstances = []
    let routes = [
      await models.Route.create(_.defaults({
        transportCompanyId: transportCompany.id,
      }, routeInfo)),
      await models.Route.create(_.defaults({
        transportCompanyId: transportCompany2.id,
      }, routeInfo)),
    ]
    testInstances.push(routes[0])
    testInstances.push(routes[1])
    let trips = [
      {
        routeId: routes[0].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10020, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40030, 20020])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
      {
        routeId: routes[1].id,
        capacity: 10,
        seatsAvailable: 10,
        status: "ACTIVE",
        transportCompanyId: transportCompany.id,
        driverId: null,
        vehicleId: null,
        date: new Date("2016-02-01T00:00:00Z"),

        tripStops: [
          { stop: { coordinates: {type: "Point", coordinates: toWGS([10000, 20000])}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
          { stop: { coordinates: {type: "Point", coordinates: toWGS([40000, 20000])}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
        ],
      },
    ]

    trips = trips.map((trInfo) => models.Trip.create(trInfo, {
      include: [{
        model: models.TripStop,
        include: [models.Stop],
      }],
    }))
    trips = await Promise.all(trips)
    for (let tr of trips) {
      testInstances.push(tr)
    }

    // Tag with A
    let startLatLng = toWGS([10100, 19600]) // Nearby to both stops
    let endLatLng = toWGS([40200, 20200])
    let response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
        transportCompanyId: transportCompany.id,
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)

    let routeIds = response.result.map(r => r.id)
    expect(routeIds).to.include(routes[0].id)
    expect(routeIds).to.not.include(routes[1].id)

    // no specified transportCompanyId
    startLatLng = toWGS([10100, 19600]) // Nearby to both stops
    endLatLng = toWGS([40200, 20200])
    response = await server.inject({
      url: "/routes/search_by_latlon?" + querystring.stringify({
        startLat: startLatLng[1],
        startLng: startLatLng[0],
        endLat: endLatLng[1],
        endLng: endLatLng[0],
        arrivalTime: new Date("1970-01-01T08:00:00+0800").toISOString(),
        startTime: new Date("2016-02-01T00:00:00+0800").toISOString(),
        endTime: new Date("2016-02-03T00:00:00+0800").toISOString(),
      }),
      method: "GET",
    })
    expect(response.statusCode).to.equal(200)

    routeIds = response.result.map(r => r.id)
    expect(routeIds).to.include(routes[0].id)
    expect(routeIds).to.include(routes[1].id)

    try {
      testInstances = testInstances.map((t) => t.destroy())
      await Promise.all(testInstances)
    } catch (err) {
      console.error(err.stack)
    }
  })


  lab.test("Search by Tags", async function () {
    // elements of testInstances will be destroyed at the end
    const m = models

    let stopInsts = [
      await m.Stop.create({
        description: "Stop 1 Description",
        road: "Stop 1 road",
      }),
      await m.Stop.create({
        description: "Stop 2 Description",
        road: "Stop 2 road",
      }),
    ]
    let routeInsts = await Promise.all([
      models.Route.create(_.assign({tags: ['tag1']}, routeInfo)),
      models.Route.create(_.assign({tags: ['tag2']}, routeInfo)),
      models.Route.create(_.assign({tags: ['tag1', 'tag2']}, routeInfo)),
      models.Route.create(_.assign({tags: []}, routeInfo)),
      models.Route.create(_.assign({tags: null}, routeInfo)),
    ])

    let tripData = {
      capacity: 10,
      seatsAvailable: 10,
      status: "ACTIVE",
      transportCompanyId: transportCompany.id,
      driverId: null,
      vehicleId: null,
      date: new Date("2016-02-01T00:00:00Z"),

      tripStops: [
        { stopId: stopInsts[0].id, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
        { stopId: stopInsts[1].id, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"},
      ],
    }

    let tripInsts = await Promise.all([
      models.Trip.create(
        _.assign({routeId: routeInsts[0].id}, tripData),
        {include: [models.TripStop]}),
      models.Trip.create(
        _.assign({routeId: routeInsts[1].id}, tripData),
        {include: [models.TripStop]}),
      models.Trip.create(
        _.assign({routeId: routeInsts[2].id}, tripData),
        {include: [models.TripStop]}),
      models.Trip.create(
        _.assign({routeId: routeInsts[3].id}, tripData),
        {include: [models.TripStop]}),
      models.Trip.create(
        _.assign({routeId: routeInsts[4].id}, tripData),
        {include: [models.TripStop]}),
    ])

    // Querying by tags should return the route
    let queryResult = await server.inject({
      url: '/routes?' + querystring.stringify({
        tags: JSON.stringify([]),
        startDate: '2016-02-01T07:59:00+0800',
        endDate: '2016-02-01T08:01:00+0800',
      }),
      method: 'GET',
    })
    let queryRoutes = queryResult.result
    let routeIds = queryRoutes.map(r => r.id)

    expect(routeIds).to.include(routeInsts[0].id)
    expect(routeIds).to.include(routeInsts[1].id)
    expect(routeIds).to.include(routeInsts[2].id)
    expect(routeIds).to.include(routeInsts[3].id)
    expect(routeIds).to.include(routeInsts[4].id)

    // Querying by tags should return the route
    queryResult = await server.inject({
      url: '/routes?' + querystring.stringify({
        tags: JSON.stringify(['tag1']),
        startDate: '2016-02-01T07:59:00+0800',
        endDate: '2016-02-01T08:01:00+0800',
      }),
      method: 'GET',
    })
    queryRoutes = queryResult.result
    routeIds = queryRoutes.map(r => r.id)

    expect(routeIds).to.include(routeInsts[0].id)
    expect(routeIds).to.not.include(routeInsts[1].id)
    expect(routeIds).to.include(routeInsts[2].id)
    expect(routeIds).to.not.include(routeInsts[3].id)
    expect(routeIds).to.not.include(routeInsts[4].id)

    queryResult = await server.inject({
      url: '/routes?' + querystring.stringify({
        tags: JSON.stringify(['tag2']),
        startDate: '2016-02-01T07:59:00+0800',
        endDate: '2016-02-01T08:01:00+0800',
      }),
      method: 'GET',
    })
    queryRoutes = queryResult.result
    routeIds = queryRoutes.map(r => r.id)

    expect(routeIds).to.not.include(routeInsts[0].id)
    expect(routeIds).to.include(routeInsts[1].id)
    expect(routeIds).to.include(routeInsts[2].id)
    expect(routeIds).to.not.include(routeInsts[3].id)
    expect(routeIds).to.not.include(routeInsts[4].id)

    queryResult = await server.inject({
      url: '/routes?' + querystring.stringify({
        tags: JSON.stringify(['tag2', 'tag1']),
        startDate: '2016-02-01T07:59:00+0800',
        endDate: '2016-02-01T08:01:00+0800',
      }),
      method: 'GET',
    })
    queryRoutes = queryResult.result
    routeIds = queryRoutes.map(r => r.id)

    expect(routeIds).to.not.include(routeInsts[0].id)
    expect(routeIds).to.not.include(routeInsts[1].id)
    expect(routeIds).to.include(routeInsts[2].id)
    expect(routeIds).to.not.include(routeInsts[3].id)
    expect(routeIds).to.not.include(routeInsts[4].id)

    await Promise.all(tripInsts.map(t => t.destroy()))
    await Promise.all(stopInsts.map(t => t.destroy()))
    await Promise.all(routeInsts.map(t => t.destroy()))
  })

  lab.test("Recent Routes", async function () {
    const m = models
    let transportCompany = await m.TransportCompany.create({
    })
    let user = await m.User.create({
      email: new Date().toISOString() + "@example.com",
    })

    const route1TripDate = new Date(Date.now() + 24 * 60 * 60 * 1000)

    let routes = [
      await m.Route.create({
        path: [],
        name: "Route 1",
        from: "Route 1 From",
        to: "Route 1 To",
        label: "Route 1 label",
        trips: [
          {
            transportCompanyId: transportCompany.id,
            date: "2017-01-01",
          },
          {
            transportCompanyId: transportCompany.id,
            date: route1TripDate,
          },
        ],
      }, {
        include: [m.Trip],
      }),
      await m.Route.create({
        path: [],
        name: "Route 2",
        from: "Route 2 From",
        to: "Route 2 To",
        label: "Route 2 label",
        trips: [
          {
            transportCompanyId: transportCompany.id,
            date: "2017-01-02",
          },
        ],
      }, {
        include: [m.Trip],
      }),
    ]
    let stops = [
      await m.Stop.create({
        description: "Stop 1 Description",
        road: "Stop 1 road",
      }),
      await m.Stop.create({
        description: "Stop 2 Description",
        road: "Stop 2 road",
      }),
    ]
    let tripStops = [
      // Create stops for trips in the past...
      await m.TripStop.create({
        time: "2017-01-02T01:00",
        stopId: stops[0].id,
        tripId: routes[0].trips[0].id,
      }),
      await m.TripStop.create({
        time: "2017-01-02T01:20",
        stopId: stops[1].id,
        tripId: routes[0].trips[0].id,
      }),
      await m.TripStop.create({
        time: "2017-01-02T01:09",
        stopId: stops[1].id,
        tripId: routes[1].trips[0].id,
      }),
      await m.TripStop.create({
        time: "2017-01-02T01:10",
        stopId: stops[0].id,
        tripId: routes[1].trips[0].id,
      }),
      // ... as well as in the present day
      await m.TripStop.create({
        time: new Date(route1TripDate.getTime() + 60 * 60 * 1000),
        stopId: stops[0].id,
        tripId: routes[0].trips[1].id,
      }),
      await m.TripStop.create({
        time: new Date(route1TripDate.getTime() + 80 * 60 * 1000),
        stopId: stops[1].id,
        tripId: routes[0].trips[1].id,
      }),
    ]

    // We have set up the environment, now we can create the ticket.
    let tickets = [
      await m.Ticket.create({
        boardStopId: tripStops[0].id,
        alightStopId: tripStops[1].id,
        userId: user.id,
        createdAt: "2017-02-01T00:00:00",
        status: 'valid',
      }),
      await m.Ticket.create({
        boardStopId: tripStops[2].id,
        alightStopId: tripStops[3].id,
        userId: user.id,
        createdAt: "2017-02-03T00:00:00",
        status: 'valid',
      }),
    ]

    let loginResp = await loginAs("user", {
      userId: user.id,
    }, null)
    let authHeaders = {
      authorization: "Bearer " + loginResp.result.sessionToken,
    }

    let resp = await server.inject({
      method: "GET",
      url: "/routes/recent",
      headers: authHeaders,
    })

    expect(resp.result.length).to.equal(1)
    expect(resp.result[0].id).to.equal(routes[0].id)
    expect(resp.result[0].boardStopStopId).to.equal(tripStops[0].stopId)
    expect(resp.result[0].alightStopStopId).to.equal(tripStops[1].stopId)

    resp = await server.inject({
      method: "GET",
      url: "/routes/recent?startDateTime=2016-12-31",
      headers: authHeaders,
    })

    expect(resp.result[0].id).to.equal(routes[1].id)
    expect(resp.result[1].id).to.equal(routes[0].id)

    expect(resp.result[0].boardStopStopId).to.equal(tripStops[2].stopId)
    expect(resp.result[0].alightStopStopId).to.equal(tripStops[3].stopId)
    expect(resp.result[1].boardStopStopId).to.equal(tripStops[0].stopId)
    expect(resp.result[1].alightStopStopId).to.equal(tripStops[1].stopId)

    // Reorder the dates...
    // Unfortunately sequelize does not allow us
    // to set `createdAt` using the model
    await db.query(
      `
UPDATE "tickets" SET "createdAt" = :createdAt
WHERE id = :id
    `,
      {
        replacements: {
          createdAt: "2016-12-31T00:00:00",
          id: tickets[1].id,
        },
      }
    )

    resp = await server.inject({
      method: "GET",
      url: "/routes/recent?startDateTime=2016-12-31",
      headers: authHeaders,
    })

    expect(resp.result[0].id).to.equal(routes[0].id)
    expect(resp.result[1].id).to.equal(routes[1].id)

    let objects = [].concat(tickets, tripStops, stops, routes, [user, transportCompany])

    for (let o of objects) {
      await o.destroy()
    }
  })

  lab.test("Recent and Similar Routes", async function () {
    const m = models
    const companyInstance = await m.TransportCompany.create({})
    const userInstance = await m.User.create({email: randomEmail()})
    const routes = await Promise.all(_.range(6).map(i => m.Route.create({
      path: [],
      name: `Route ${i}`,
      from: `Route ${i} From`,
      to: `Route ${i} To`,
      label: `Route ${i} Label`,
      transportCompanyId: companyInstance.id,
      trips: [
        {
          transportCompanyId: companyInstance.id,
          date: "2017-01-01",
        },
      ],
    }, {
      include: [m.Trip],
    })
    ))
    const headers = {authorization: `Bearer ${userInstance.makeToken()}`}
    const stops = await Promise.all([
      m.Stop.create({
        description: 'Inside botanic gardens (1)',
        coordinates: {
          type: 'Point', coordinates: [103.815780, 1.311889],
        },
      }),
      m.Stop.create({
        description: 'Inside botanic gardens (2)',
        coordinates: {
          type: 'Point', coordinates: [103.816155, 1.311449],
        },
      }),
      m.Stop.create({
        description: 'Mt Vernon (1)',
        coordinates: {
          type: 'Point', coordinates: [103.880988, 1.340020],
        },
      }),
      m.Stop.create({
        description: 'Mt Vernon (2)',
        coordinates: {
          type: 'Point', coordinates: [103.882555, 1.338111],
        },
      }),
      m.Stop.create({
        description: 'PLAB',
        coordinates: {
          type: 'Point', coordinates: [103.900423, 1.350496],
        },
      }),
    ])

    const createTripOnRoute = async function (route, stop1, stop2) {
      return Promise.all([
        m.TripStop.create({
          tripId: route.trips[0].id,
          stopId: stop1.id,
          canBoard: true,
          canAlight: false,
          time: "2017-01-01T08:00:00+0800",
        }),
        m.TripStop.create({
          tripId: route.trips[0].id,
          stopId: stop2.id,
          canBoard: false,
          canAlight: true,
          time: "2017-01-01T08:00:00+0800",
        }),
      ])
    }

    const tripStopsPairs = await Promise.all([
      createTripOnRoute(routes[0], stops[0], stops[2]),
      createTripOnRoute(routes[1], stops[1], stops[3]), // similar, 2 diff stops
      createTripOnRoute(routes[2], stops[0], stops[3]), // similar, 1 diff stop
      createTripOnRoute(routes[3], stops[3], stops[1]), // similar, switched around
      createTripOnRoute(routes[4], stops[3], stops[4]), // dissimilar
      createTripOnRoute(routes[5], stops[0], stops[2]), // exactly similar
    ])

    // We have set up the environment, now we can create the ticket.
    await m.Ticket.create({
      boardStopId: tripStopsPairs[0][0].id,
      alightStopId: tripStopsPairs[0][1].id,
      userId: userInstance.id,
      createdAt: "2016-12-31T00:00:00Z",
      updatedAt: "2016-12-31T00:00:00Z",
      status: 'valid',
    })

    // Regular
    const resp = await server.inject({
      method: "GET",
      url: "/routes/similarToRecent?" + querystring.stringify({
        maxDistance: 500,
        startDateTime: '2016-12-01T00:00:00+0800',
        endDateTime: '2017-01-02T23:59:00+0800',
      }),
      headers,
    })
    const returnedRouteIds = resp.result.map(r => r.id)
    expect(returnedRouteIds).include(routes[0].id)
    expect(returnedRouteIds).include(routes[1].id)
    expect(returnedRouteIds).include(routes[2].id)
    expect(returnedRouteIds).include(routes[3].id)
    expect(returnedRouteIds).not.include(routes[4].id)
    expect(returnedRouteIds).include(routes[5].id)

    // Check presence of additional data
    expect(resp.result[0].boardStopStopId).exist()
    expect(resp.result[0].alightStopStopId).exist()
    expect(resp.result[0].isRecentlyBooked).exist()
    expect(resp.result.find(r => r.id === routes[0].id).isRecentlyBooked).true()
    expect(resp.result.find(r => r.id === routes[1].id).isRecentlyBooked).false()

    // Date time range invalid
    const resp2 = await server.inject({
      method: "GET",
      url: "/routes/similarToRecent?" + querystring.stringify({
        maxDistance: 500,
        startDateTime: '2017-01-02T00:00:00+0800',
        endDateTime: '2017-01-03T23:59:00+0800',
      }),
      headers,
    })
    const returnedRouteIds2 = resp2.result.map(r => r.id)
    expect(returnedRouteIds2).not.include(routes[0].id)
    expect(returnedRouteIds2).not.include(routes[1].id)
    expect(returnedRouteIds2).not.include(routes[2].id)
    expect(returnedRouteIds2).not.include(routes[3].id)
    expect(returnedRouteIds2).not.include(routes[4].id)
    expect(returnedRouteIds2).not.include(routes[5].id)

    // MaxDistance works -- set limit to 5 metres
    const resp3 = await server.inject({
      method: "GET",
      url: "/routes/similarToRecent?" + querystring.stringify({
        maxDistance: 5,
        startDateTime: '2017-01-01T00:00:00+0800',
        endDateTime: '2017-01-03T23:59:00+0800',
      }),
      headers,
    })
    const returnedRouteIds3 = resp3.result.map(r => r.id)
    expect(returnedRouteIds3).include(routes[0].id)
    expect(returnedRouteIds3).not.include(routes[1].id)
    expect(returnedRouteIds3).not.include(routes[2].id)
    expect(returnedRouteIds3).not.include(routes[3].id)
    expect(returnedRouteIds3).not.include(routes[4].id)
    expect(returnedRouteIds3).include(routes[5].id)
  })

  lab.test("Admins may not change label / tags but may change company tags", async function () {
    const adminInstance = await models.Admin.create({
      email: randomEmail(),
    })
    await adminInstance.addTransportCompany(transportCompany, {permissions: ['manage-routes']})
    const authHeaders = {
      authorization: "Bearer " + adminInstance.makeToken(),
    }
    const superadminAuthHeaders = {
      authorization: "Bearer " + (await loginAs('superadmin')).result.sessionToken,
    }

    // When admin tries to create a route, label and tags are deleted
    const routeInfo = {
      label: 'HelloLabel',
      tags: ['some', 'tag'],
      from: 'From',
      to: 'To',
      name: 'Sample Route',
      features: 'Some feature',
      transportCompanyId: transportCompany.id,
    }

    const latest = function () {
      return models.Route.findOne({
        order: [['id', 'desc']],
      })
    }
    const noLabelAndTags = function (r) {
      expect(r.label).null()
      expect(r.tags).null()
    }
    const matchesLabelAndTags = function (r) {
      expect(r.label).equal(routeInfo.label)
      expect(r.tags).equal(routeInfo.tags)
    }
    const matchesEverythingElse = function (r) {
      expect(r.from).equal(routeInfo.from)
      expect(r.transportCompanyId).equal(routeInfo.transportCompanyId)
      expect(r.to).equal(routeInfo.to)
      expect(r.name).equal(routeInfo.name)
    }

    // Created by admin, no label and tags
    let response
    response = await server.inject({
      method: "POST",
      url: "/routes",
      payload: routeInfo,
      headers: authHeaders,
    })
    expect(response.statusCode).equal(200)
    const routePostByAdmin = await latest()
    noLabelAndTags(routePostByAdmin)
    matchesEverythingElse(routePostByAdmin)

    // Created by superadmin, no label and tags
    response = await server.inject({
      method: "POST",
      url: "/routes",
      payload: routeInfo,
      headers: superadminAuthHeaders,
    })
    expect(response.statusCode).equal(200)
    const routePostBySuperadmin = await latest()
    matchesLabelAndTags(routePostBySuperadmin)
    matchesEverythingElse(routePostBySuperadmin)


    // Created by admin, no label and tags
    response = await server.inject({
      method: "PUT",
      url: `/routes/${routePostBySuperadmin.id}`,
      payload: _.defaults({
        label: 'NewLabel',
        tags: ['new', 'tags'],
        companyTags: ['banana'],
      }, routeInfo),
      headers: authHeaders,
    })
    expect(response.statusCode).equal(200)
    const routePutByAdmin = await latest()
    matchesLabelAndTags(routePutByAdmin)
    matchesEverythingElse(routePutByAdmin)
    expect(routePutByAdmin.companyTags).equal(['banana'])

    response = await server.inject({
      method: "PUT",
      url: `/routes/${routePostBySuperadmin.id}`,
      payload: _.defaults({
        label: 'NewLabel',
        tags: ['new', 'tags'],
      }, routeInfo),
      headers: superadminAuthHeaders,
    })
    expect(response.statusCode).equal(200)
    const routePutBySuperadmin = await latest()
    matchesEverythingElse(routePutBySuperadmin)
    expect(routePutBySuperadmin.label).equal('NewLabel')
    expect(routePutBySuperadmin.tags).equal(['new', 'tags'])
  })

  lab.test("Only unique tags are allowed", async function () {
    const testTags1 = ['aaa', 'aaa']
    const testTags2 = ['bbb', 'bbb']

    const routeInfo = {
      label: 'HelloLabel',
      tags: testTags1,
      from: 'From',
      to: 'To',
      name: 'Sample Route',
      features: 'Some feature',
      transportCompanyId: transportCompany.id,
    }

    const superadminAuthHeaders = {
      authorization: "Bearer " + (await loginAs('superadmin')).result.sessionToken,
    }

    let createResponse = await server.inject({
      method: "POST",
      url: "/routes",
      payload: routeInfo,
      headers: superadminAuthHeaders,
    })

    expect(createResponse.statusCode).equal(200)

    let route = await models.Route.findOne({
      order: [['id', 'desc']],
    })
    expect(route.tags.length).equal(1)

    let updateResponse = await server.inject({
      method: "PUT",
      url: `/routes/${route.id}`,
      payload: _.defaults({
        label: 'NewLabel',
        tags: testTags2,
      }, routeInfo),
      headers: superadminAuthHeaders,
    })

    expect(updateResponse.statusCode).equal(200)

    await route.reload()
    expect(route.tags.length).equal(1)
  })

  lab.test("createdAt/updatedAt route timestamps cannot be overridden at POST", async function () {
    const headers = {
      authorization: "Bearer " + (await loginAs('superadmin')).result.sessionToken,
    }

    const payload = {
      label: 'HelloLabel',
      tags: ['some', 'tag'],
      from: 'From',
      to: 'To',
      name: 'Sample Route',
      features: 'Some feature',
      transportCompanyId: transportCompany.id,
      createdAt: new Date('1970-01-01'),
      updatedAt: new Date('1970-01-02'),
    }

    const response = await server.inject({
      method: "POST",
      url: "/routes",
      payload,
      headers,
    })
    expect(response.statusCode).equal(200)

    const routeId = response.result.id
    const route = await models.Route.findById(routeId)
    expect(new Date(route.updatedAt)).not.equal(payload.updatedAt)
    expect(new Date(route.createdAt)).not.equal(payload.createdAt)
  })
})
