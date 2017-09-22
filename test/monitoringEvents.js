const tool = require('../src/lib/daemons/monitoring')

const Lab = require("lab")
const Code = require('code')
const _ = require('lodash')
const {randomSingaporeLngLat} = require("./test_common")
const {toWGS, toSVY} = require('../src/lib/util/svy21')
const eventHandlers = require('../src/lib/events/handlers')

const {db, models: m} = require("../src/lib/core/dbschema")()
export var lab = Lab.script()
const eventsDaemon = require('../src/lib/daemons/eventSubscriptions')
const {expect} = Code

lab.experiment("Integration test for monitoring events", function () {
  var companyInstance, userInstance, driverInstance, vehicleInstance,
    stopInstances, stopsById

  function delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  let payloads = []

  async function pollAndProcess () {
    return tool.processStatus(await tool.poll())
  }

  async function expectEvent (event, severity, params, fn) {
    var uid = Math.random()

    await m.EventSubscription.create({
      agent: {
        uid,
      },
      event, params,
      formatter: '0',
      handler: 'debug' // This handler is monkey-patched in before()
    })

    await eventsDaemon.updateEventSubscriptions({db, models: m})

    await fn()

    await delay(100)

    let emitted = payloads.find(p => p.agent.uid === uid)
    expect(emitted).exist()
    if (severity) {
      expect(emitted.payload.severity).equal(severity)
    }
  }

  lab.before({timeout: 20000}, async function () {
    eventHandlers.debug = (agent, payload) => {
      payloads.push({agent, payload})
    }

    userInstance = await m.User.create({
      email: `testuser${Date.now()}@example.com`,
      name: "Test user",
      telephone: Date.now(),
    })

    companyInstance = await m.TransportCompany.create({
      name: "Test company",
    })

    driverInstance = await m.Driver.create({
      name: 'Test driver',
      telephone: `TEST-${Date.now()}`
    })

    vehicleInstance = await m.Vehicle.create({
      driverId: driverInstance.id,
    })

    // Create stops
    stopInstances = await Promise.all(
      _.range(0, 8).map((i) => m.Stop.create({
        description: `Test Stop ${i + 1}`,
        coordinates: {
          type: "Point",
          coordinates: randomSingaporeLngLat()
        }
      }))
    )

    stopsById = _.keyBy(stopInstances, 'id')

    await driverInstance.addTransportCompany(companyInstance)
  })

  async function createPing (tripInstance, date = new Date(), tripStop = null, distance = 50) {
    await tripInstance.update({
      driverId: driverInstance.id,
      vehicleId: vehicleInstance.id,
    })

    let coords = null
    if (!tripStop) {
      coords = [100, 100] // Somewhere in the sea...
    } else {
      coords = toSVY(stopsById[tripStop.stopId].coordinates.coordinates)
    }
    var xy2 = [coords[0] + distance, coords[1]]

    return await m.Ping.create({
      createdAt: date,
      updatedAt: date,
      tripId: tripInstance.id,
      driverId: driverInstance.id,
      vehicleId: vehicleInstance.id,
      coordinates: {
        type: 'Point',
        coordinates: toWGS(xy2)
      }
    })
  }

  async function createRouteStopsTrips (minsOffset) {
    var now = Date.now()

    // create Route
    var routeInstance = await m.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To"
    })

    // create some trips...
    var tripInstance = await m.Trip.create({
      date: new Date(now),
      capacity: 10,
      routeId: routeInstance.id,
      price: (Math.random() * 3 + 3).toFixed(2),
      transportCompanyId: companyInstance.id,
      tripStops: [
        { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 0) * 60000)},
        { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 10) * 60000)},
        { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 20) * 60000)},

        { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 30) * 60000)},
        { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 40) * 60000)}
      ],
      bookingInfo: {
        windowType: 'stop',
        windowSize: 0,
      }
    }, {
      include: [{model: m.TripStop}]
    })

    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[2].id,
      userId: userInstance.id,
      status: 'valid'
    })

    return [routeInstance, tripInstance]
  }

  lab.test("No pings event (-5mins)", async function () {
    let [routeInstance] = await createRouteStopsTrips(-5)

    await expectEvent(
      'noPings', 5,
      {minsBefore: [5], routeIds: [routeInstance.id]},
      pollAndProcess)
  })

  lab.test("No pings event (-10mins)", async function () {
    let [routeInstance] = await createRouteStopsTrips(10)

    await expectEvent(
      'noPings', 4,
      {minsBefore: [10], routeIds: [routeInstance.id]},
      pollAndProcess)
  })

  lab.test("Late arrival", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(-10)

    await createPing(tripInstance, new Date(), tripInstance.tripStops[0])

    await expectEvent(
      'lateArrival', null, {timeAfter: 10 * 60000, routeIds: [routeInstance.id]},
      pollAndProcess)
  })

  lab.test("Late arrival (negative)", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(-8)

    await createPing(tripInstance, new Date(), tripInstance.tripStops[0])

    // Negative because timeAfter = 10, but this is only 8 minutes ago
    await expectEvent(
      'lateArrival', null, {timeAfter: 10 * 60000, routeIds: [routeInstance.id]},
      pollAndProcess)
      .then(() => expect.fail(), () => {})
  })

  lab.test("Late ETA", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(0)

    await createPing(tripInstance, new Date(), tripInstance.tripStops[0],
      35 /* km/h*/ / 3.6 /* m/s*/ * 10 * 60 /* distance in 10 mins */ + 10)

    await expectEvent(
      'lateETA', null, {timeAfter: 10 * 60000, routeIds: [routeInstance.id]},
      pollAndProcess)
  })

  lab.test("Late ETA (negative)", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(0)

    await createPing(tripInstance, new Date(), tripInstance.tripStops[0],
      35 /* km/h*/ / 3.6 /* m/s*/ * 10 * 60 /* distance in 10 mins */ - 10)

    // Negative because timeAfter = 10, but this is only 8 minutes ago
    await expectEvent(
      'lateETA', null, {timeAfter: 10 * 60000, routeIds: [routeInstance.id]},
      pollAndProcess)
      .then(() => expect.fail(), () => {})
  })
})
