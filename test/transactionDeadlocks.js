/* eslint no-await-in-loop: 0*/
let Lab = require("lab")
let lab = exports.lab = Lab.script()

const {expect} = require("code")
let server = require("../src/index.js")
let _ = require("lodash")

const {models} = require("../src/lib/core/dbschema")()
const {createStripeToken} = require("./test_common")

const testMerchantId = process.env.STRIPE_TEST_DESTINATION

lab.experiment("Concurrent transactions", function () {
  let testInstances = []
  let stopInstances = []
  let tripInstances = []


  // Additional tests we may/will want to carry out:
  //  - Test that booking window works
  //  - ...
  const randomSingaporeLngLat = () => {
    return [
      103.69 + Math.random() * 0.29,
      1.286 + Math.random() * 0.18,
    ]
  }

  lab.before({timeout: 10000}, async () => {
    let routeInstance
    let tripIncludes = {
      include: [{model: models.TripStop }],
    }

    let user = await models.User.create({
      email: "testuser1" + new Date().getTime() +
                "@testtestexample.com",
      name: " Test use r r r r",
      telephone: Date.now(),
    })
    testInstances.push(user)

    let company = await models.TransportCompany.create({
      name: " Test compan y y y y ",
      clientId: testMerchantId,
      sandboxId: testMerchantId,
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
        coordinates: { type: "Point", coordinates: randomSingaporeLngLat() },
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
          { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: dateStr + "T09:55:00Z"},
        ],
      }, tripIncludes)
      tripInstances.push(trip)
    }
    testInstances = testInstances.concat(tripInstances)

    // then we are ready to test!
  })

  /* Seems like there IS a deadlock! */
  lab.test("Deadlock - at least one should succeed", {timeout: 3000}, async function () {
    // create 11 fake users
    let time = new Date().getTime()
    let ids = _.range(0, 5)
    let fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com",
    })))

    let sessionTokens = fakeUsers.map(f => f.makeToken())

    // Inject the ticket purchases
    let fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          },
        ],
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i],
      },
    }))

    let results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })

  /* Seems like there IS a deadlock! */
  lab.test("Concurrent payments", {timeout: 10000}, async function () {
    // create 11 fake users
    let time = new Date().getTime()
    let ids = _.range(0, 5)
    let fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com",
    })))

    let sessionTokens = fakeUsers.map(f => f.makeToken())

    const stripeTokens = await Promise.all(ids.map((i) => createStripeToken()))

    // Inject the ticket purchases
    let fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          },
        ],
        stripeToken: stripeTokens[i],
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i],
      },
    }))

    let results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.include(200)
  })

  // For this one, because the trips are all different, we expect concurrent access to work...
  lab.test("Concurrent transactions on different trips", {timeout: 2000}, async function () {
    let time = new Date().getTime()
    let ids = _.range(0, 5)
    let fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com",
    })))

    let sessionTokens = fakeUsers.map(f => f.makeToken())

    // Inject the ticket purchases
    let fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [
          {
            tripId: tripInstances[i].id,
            boardStopId: tripInstances[i].tripStops[0].id,
            alightStopId: tripInstances[i].tripStops[4].id,
          },
        ],
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i],
      },
    }))

    let results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })

  /**
   * Ensure that concurrent payments on different trips get through
   */
  lab.test("Concurrent payments on different trips", {timeout: 10000}, async function () {
    // create 11 fake users
    let time = new Date().getTime()
    let ids = _.range(0, 5)
    let fakeUsers = await Promise.all(ids.map(i => models.User.create({
      name: `Some user ${i}`,
      email: "test-user-" + (time + i) + "@example.com",
    })))

    let sessionTokens = fakeUsers.map(f => f.makeToken())

    const stripeTokens = await Promise.all(ids.map((i) => createStripeToken()))

    // Inject the ticket purchases
    let fakeSales = ids.map((i) => server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [
          {
            tripId: tripInstances[i].id,
            boardStopId: tripInstances[i].tripStops[0].id,
            alightStopId: tripInstances[i].tripStops[0].id,
          },
        ],
        stripeToken: stripeTokens[i],
      },
      headers: {
        authorization: "Bearer " + sessionTokens[i],
      },
    }))

    let results = await Promise.all(fakeSales)
    expect(results.map(r => r.statusCode)).to.only.include(200)
  })
})
