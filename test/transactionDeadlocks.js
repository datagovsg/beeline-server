/* eslint no-await-in-loop: 0*/
var Lab = require("lab")
var lab = exports.lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index.js")
var _ = require("lodash")

const {models} = require("../src/lib/core/dbschema")()
const stripe = require("../src/lib/transactions/payment").stripe

const testMerchantId = process.env.STRIPE_TEST_DESTINATION
import BlueBird from 'bluebird'

lab.experiment("Concurrent transactions", function () {
  var testInstances = []
  var stopInstances = []
  var tripInstances = []


  // Additional tests we may/will want to carry out:
  //  - Test that booking window works
  //  - ...
  function randomSingaporeLngLat () {
    return [
      103.69 + Math.random() * 0.29,
      1.286 + Math.random() * 0.18
    ]
  }

  lab.before({timeout: 10000}, async () => {
    var routeInstance
    var tripIncludes = {
      include: [{model: models.TripStop }]
    }

    var user = await models.User.create({
      email: "testuser1" + new Date().getTime() +
                "@testtestexample.com",
      name: " Test use r r r r",
      telephone: Date.now()
    })
    testInstances.push(user)

    var company = await models.TransportCompany.create({
      name: " Test compan y y y y ",
      clientId: testMerchantId,
      sandboxId: testMerchantId
    })
    testInstances.push(company)

    // create a bunch of stops
    routeInstance = await models.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To",
      transportCompanyId: company.id,
    })

    for (let i = 0; i < 7; i++) {
      let stop = await models.Stop.create({
        description: `Test stop ${i}`,
        coordinates: { type: "Point", coordinates: randomSingaporeLngLat() }
      })
      stopInstances.push(stop)
    }

    let baseDate = new Date("2020-03-05")
    for (let i = 0; i < 10; i++) {
      let date = new Date(baseDate.getTime())
      date.setDate(date.getDate() + i)
      let dateStr = date.toISOString().substr(0, 10)

      let trip = await models.Trip.create({
        date: date,
        capacity: 10,
        routeId: routeInstance.id,
        price: parseInt(400 + Math.random() * 400) / 100,
        tripStops: [
          { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: dateStr + "T08:30:00Z"},
          { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: dateStr + "T08:35:00Z"},
          { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: dateStr + "T08:40:00Z"},
          { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: dateStr + "T09:50:00Z"},
          { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: dateStr + "T09:55:00Z"}
        ]
      }, tripIncludes)
      tripInstances.push(trip)
    }
    testInstances = testInstances.concat(tripInstances)

    // then we are ready to test!
  })

  /* Seems like there IS a deadlock! */
  lab.test("Deadlock - at least one should succeed", {timeout: 3000}, async function () {
    // create 11 fake users
    var time = new Date().getTime()
    var ids = _.range(0, 5)
    var fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com"
    })))

    var sessionTokens = fakeUsers.map(f => f.makeToken())

    // Inject the ticket purchases
    var fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          }
        ]
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i]
      }
    }))

    var results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })

  /* Seems like there IS a deadlock! */
  lab.test("Concurrent payments", {timeout: 10000}, async function () {
    // create 11 fake users
    var time = new Date().getTime()
    var ids = _.range(0, 5)
    var fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com"
    })))

    var sessionTokens = fakeUsers.map(f => f.makeToken())

    var stripeTokens = await Promise.all(ids.map((i) =>
      // create a stripe token! Using the fake credit card details
      BlueBird.promisify(stripe.tokens.create, {context: stripe.tokens})({
        card: {
          number: "4242424242424242",
          exp_month: "12",
          exp_year: "2017",
          cvc: "123"
        }
      })))

    // Inject the ticket purchases
    var fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          }
        ],
        stripeToken: stripeTokens[i].id
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i]
      }
    }))

    var results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.include(200)
  })

  // For this one, because the trips are all different, we expect concurrent access to work...
  lab.test("Concurrent transactions on different trips", {timeout: 2000}, async function () {
    var time = new Date().getTime()
    var ids = _.range(0, 5)
    var fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com"
    })))

    var sessionTokens = fakeUsers.map(f => f.makeToken())

    // Inject the ticket purchases
    var fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [
          {
            tripId: tripInstances[i].id,
            boardStopId: tripInstances[i].tripStops[0].id,
            alightStopId: tripInstances[i].tripStops[4].id,
          }
        ]
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i]
      }
    }))

    var results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })

  /**
   * Ensure that concurrent payments on different trips get through
   */
  lab.test("Concurrent payments on different trips", {timeout: 10000}, async function () {
    // create 11 fake users
    var time = new Date().getTime()
    var ids = _.range(0, 5)
    var fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com"
    })))

    var sessionTokens = fakeUsers.map(f => f.makeToken())

    var stripeTokens = await Promise.all(ids.map((i) =>
      // create a stripe token! Using the fake credit card details
      BlueBird.promisify(stripe.tokens.create, {context: stripe.tokens})({
        card: {
          number: "4242424242424242",
          exp_month: "12",
          exp_year: "2017",
          cvc: "123"
        }
      })))

    // Inject the ticket purchases
    var fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [
          {
            tripId: tripInstances[i].id,
            boardStopId: tripInstances[i].tripStops[0].id,
            alightStopId: tripInstances[i].tripStops[0].id,
          }
        ],
        stripeToken: stripeTokens[i].id
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i]
      }
    }))

    var results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })
})
