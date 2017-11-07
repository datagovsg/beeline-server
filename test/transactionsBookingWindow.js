const Lab = require("lab")
const lab = exports.lab = Lab.script()

const {expect} = require('code')
const server = require("../src/index.js")
const _ = require("lodash")

const {models} = require("../src/lib/core/dbschema")()
const {loginAs} = require("./test_common")
const {createUsersCompaniesRoutesAndTrips} = require("./test_data")

lab.experiment("Transactions", function () {
  var authHeaders

  var stopInstances, tripInstances, routeInstance

  lab.beforeEach({timeout: 10000}, async () => {
    var user

    const prices = _.range(0, 9).map(() => (Math.random() * 3 + 3).toFixed(2));
    ({userInstance: user, routeInstance, stopInstances, tripInstances} =
      await createUsersCompaniesRoutesAndTrips(models, prices))

    var loginResponse = await loginAs("user", user.id)
    expect(loginResponse.statusCode).to.equal(200)

    authHeaders = {
      authorization: "Bearer " + loginResponse.result.sessionToken
    }
  })

  lab.afterEach(async () => {
    var tsIds = _.flatten(tripInstances.map(t => t.tripStops.map(ts => ts.id)))
    await models.Ticket.destroy({
      where: {
        boardStopId: {$in: tsIds}
      }
    })
    await Promise.all(tripInstances.map(t => t.destroy()))
    await Promise.all(stopInstances.map(t => t.destroy()))
    await routeInstance.destroy()
  })

  function testRequest () {
    return {
      trips: [
        {
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[1].id,
        }
      ]
    }
  }

  lab.test("Haven't reach window ==> success", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'stop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 600000)
    tripInstances[0].tripStops[1].set('time', now + 600000)
    tripInstances[0].tripStops[2].set('time', now + 600000)
    tripInstances[0].tripStops[3].set('time', now + 600000)
    tripInstances[0].tripStops[4].set('time', now + 600000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).equal(200)
  })


  lab.test("Booking window by stop. Other stops elapsed, chosen stop not yet ==> success", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'stop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 600000)
    tripInstances[0].tripStops[1].set('time', now + 600000)
    tripInstances[0].tripStops[2].set('time', now - 600000)
    tripInstances[0].tripStops[3].set('time', now - 600000)
    tripInstances[0].tripStops[4].set('time', now - 600000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).equal(200)
  })


  lab.test("Booking window by stop. Other stops not yet, chosen stop elapsed ==> fail", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'stop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now - 600000)
    tripInstances[0].tripStops[1].set('time', now + 600000)
    tripInstances[0].tripStops[2].set('time', now + 600000)
    tripInstances[0].tripStops[3].set('time', now + 600000)
    tripInstances[0].tripStops[4].set('time', now + 600000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).not.equal(200)
  })


  lab.test("Booking window by stop. 10s failure", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'stop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 10000)
    tripInstances[0].tripStops[1].set('time', now + 10000)
    tripInstances[0].tripStops[2].set('time', now + 600000)
    tripInstances[0].tripStops[3].set('time', now + 600000)
    tripInstances[0].tripStops[4].set('time', now + 600000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).not.equal(200)
  })

  lab.test("Booking window by stop. 10s success", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'stop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 20000)
    tripInstances[0].tripStops[1].set('time', now + 20000)
    tripInstances[0].tripStops[2].set('time', now + 600000)
    tripInstances[0].tripStops[3].set('time', now + 600000)
    tripInstances[0].tripStops[4].set('time', now + 600000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).equal(200)
  })

  lab.test("Booking window by firstStop. 10s success", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'firstStop',
      windowSize: -10000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 20000)
    tripInstances[0].tripStops[1].set('time', now + 20000)
    tripInstances[0].tripStops[2].set('time', now + 20000)
    tripInstances[0].tripStops[3].set('time', now + 20000)
    tripInstances[0].tripStops[4].set('time', now + 20000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).equal(200)
  })

  lab.test("Booking window by firstStop. 10s failure", async function () {
    tripInstances[0].set('bookingInfo', {
      windowType: 'firstStop',
      windowSize: -300000,
    })
    await tripInstances[0].save()
    var now = Date.now()

      // ensure success
    tripInstances[0].tripStops[0].set('time', now + 600000)
    tripInstances[0].tripStops[1].set('time', now + 600000)
    tripInstances[0].tripStops[2].set('time', now + 600000)
    tripInstances[0].tripStops[3].set('time', now + 600000)
    tripInstances[0].tripStops[4].set('time', now + 300000)
    await Promise.all(tripInstances[0].tripStops.map(ts => ts.save()))

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: testRequest(),
      headers: authHeaders
    })

    expect(saleResponse.statusCode).not.equal(200)
    expect(saleResponse.result.message)
        .to.include(new Date(now).toLocaleTimeString({ timeZone: 'Asia/Singapore' }))
  })
})
