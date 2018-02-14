// REQUIRED BY TELEGRAM
// N.B. have to use const instead of import because of the Bluebird problem
require('bluebird').config({cancellation: true})

const tool = require('../src/lib/daemons/monitoring')

const _ = require("lodash")
const {randomEmail, expectEvent} = require("./test_common")
const {toWGS, toSVY} = require('../src/lib/util/svy21')

const Lab = require('lab')
export const lab = Lab.script()
const {models: m} = require("../src/lib/core/dbschema")()
const {expect, fail} = require('code')

const timemachine = require('./timemachine-wrap')
const sinon = require("sinon")
const pollTools = require("../src/lib/daemons/pollTools")

lab.experiment("Checks on the monitoring tool", function () {
  let [companyInstance, userInstance, driverInstance, vehicleInstance,
    stopInstances, stopsById, adminInstance] = []

  let findAllPings

  lab.before(async function () {
    findAllPings = sinon.stub(pollTools, "findAllPings")

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
      telephone: `TEST-${Date.now()}`,
    })

    adminInstance = await m.Admin.create({
      email: randomEmail(),
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
          coordinates: // randomSingaporeLngLat()
            // Cannot use a random lat/lng because
            // arrival time calculation now considers the last stop
            [103.8, 1.38 + 0.02 * i],
        },
      }))
    )

    stopsById = _.keyBy(stopInstances, 'id')

    await adminInstance.addTransportCompany(companyInstance, {permissions: ['message-passengers']})
    await driverInstance.addTransportCompany(companyInstance)
  })

  lab.after(async () => {
    findAllPings.restore()
  })

  const createPings = async (tripInstance, ...pingDetails) => {
    await tripInstance.update({
      driverId: driverInstance.id,
      vehicleId: vehicleInstance.id,
    })

    const pings = pingDetails.map(({date, tripStop, distance}) => {
      const coords = tripStop
        ? toSVY(stopsById[tripStop.stopId].coordinates.coordinates)
        : [100, 100]
      const xy2 = [coords[0] + distance, coords[1]]

      return {
        createdAt: date,
        updatedAt: date,
        time: date,
        tripId: tripInstance.id,
        driverId: driverInstance.id,
        vehicleId: vehicleInstance.id,
        coordinates: {
          type: 'Point',
          coordinates: toWGS(xy2),
        },
      }
    })

    findAllPings.returns(pings)
  }

  const createPing = async (tripInstance, date = new Date(), tripStop = null, distance = 50) => {
    return createPings(tripInstance, {date, tripStop, distance})
  }

  const createRouteStopsTrips = async (minsOffset) => {
    const now = Date.now()

    // create Route
    const routeInstance = await m.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To",
    })


    // create some trips...
    const tripInstance = await m.Trip.create({
      date: new Date(now),
      capacity: 10,
      routeId: routeInstance.id,
      price: (Math.random() * 3 + 3).toFixed(2),
      transportCompanyId: companyInstance.id,
      tripStops: [
        { stopId: stopInstances[0].id, canBoard: true, canAlight: false, time: new Date(now + (minsOffset + 0) * 60000)},
        { stopId: stopInstances[1].id, canBoard: true, canAlight: false, time: new Date(now + (minsOffset + 10) * 60000)},
        { stopId: stopInstances[2].id, canBoard: true, canAlight: false, time: new Date(now + (minsOffset + 20) * 60000)},

        { stopId: stopInstances[3].id, canBoard: false, canAlight: true, time: new Date(now + (minsOffset + 30) * 60000)},
        { stopId: stopInstances[4].id, canBoard: false, canAlight: true, time: new Date(now + (minsOffset + 40) * 60000)},
      ],
      bookingInfo: {
        windowType: 'stop',
        windowSize: 0,
      },
    }, {
      include: [{model: m.TripStop}],
    })

    return [routeInstance, tripInstance, now]
  }

  lab.test("No pings within 25 minutes", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(25)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    // Alert level three should be flagged
    let r = expectEvent('noPings', { routeIds: [routeInstance.id], minsBefore: [25]})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id]).exist()
    expect(serviceStatuses[routeInstance.id].status).exist()
    expect(serviceStatuses[routeInstance.id].status.ping).equal(3)
    expect(serviceStatuses[routeInstance.id].status.emergency).equal(false)

    await r.check()
  })

  lab.test("No pings within 5 minutes", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(5)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    // Alert level three should be flagged
    let r = expectEvent('noPings', { routeIds: [routeInstance.id], minsBefore: [5]})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id]).exist()
    expect(serviceStatuses[routeInstance.id].status).exist()
    expect(serviceStatuses[routeInstance.id].status.ping).equal(4)
    expect(serviceStatuses[routeInstance.id].status.emergency).equal(false)

    await r.check()
  })

  lab.test("Emergency switched on", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(30)

    await tripInstance.update({
      status: 'cancelled',
    })

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    // Alert level three should be flagged
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id]).exist()
    expect(serviceStatuses[routeInstance.id].status).exist()
    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.emergency).equal(true)
  })


  lab.test("Pings within 25 minutes (far)", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(25)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    await createPing(tripInstance)

    // Alert level three should be flagged
    // FIXME:
    // var r = expectEvent('lateETA', { routeIds: [routeInstance.id], timeBefore: 5*60000})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id]).exist()
    expect(serviceStatuses[routeInstance.id].status).exist()
    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.emergency).equal(false)
  })

  lab.test("Pings within 5 minutes (far)", async function () {
    let [routeInstance, tripInstance] = await createRouteStopsTrips(5)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    await createPing(tripInstance)

    // Alert level three should be flagged
    // FIXME:
    // var r = expectEvent('lateETA', { routeIds: [routeInstance.id], timeBefore: 5*60000})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id]).exist()
    expect(serviceStatuses[routeInstance.id].status).exist()
    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.distance).equal(3)
    expect(serviceStatuses[routeInstance.id].status.emergency).equal(false)
  })

  lab.test("Arrived (near)", async function () {
    let [routeInstance, tripInstance, now] = await createRouteStopsTrips(1)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    await createPing(tripInstance, now, tripInstance.tripStops[0], 10)

    // Alert level three should be flagged
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.distance).below(3)
  })
  lab.test("Ping 5 minutes before (near)", async function () {
    let [routeInstance, tripInstance, now] = await createRouteStopsTrips(5)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    await createPing(tripInstance, now, tripInstance.tripStops[0], 10)

    // Alert level three should be flagged
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.distance).below(3)
  })
  lab.test("Arrive >15 minutes late", async function () {
    let [routeInstance, tripInstance, now] = await createRouteStopsTrips(0)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    // punctual with pings... but 16 mins late
    await createPings(
      tripInstance,
      { date: now, tripStop: tripInstance.tripStops[0], distance: 2000 },
      { date: now + 16 * 60000, tripStop: tripInstance.tripStops[0], distance: 10 }
    )

    // Alert level three should be flagged
    let r = expectEvent('lateArrival', { routeIds: [routeInstance.id], timeAfter: 15 * 60000})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.distance).equal(3)

    await r.check()
  })
  lab.test("Arrive >5 minutes late", async function () {
    let [routeInstance, tripInstance, now] = await createRouteStopsTrips(0)

    // Add user to trip
    await m.Ticket.create({
      boardStopId: tripInstance.tripStops[0].id,
      alightStopId: tripInstance.tripStops[3].id,
      status: 'valid',
      userId: userInstance.id,
    })

    await createPings(
      tripInstance,
      { date: now, tripStop: tripInstance.tripStops[0], distance: 2000 },
      { date: now + 6 * 60000, tripStop: tripInstance.tripStops[0], distance: 10 }
    )

    // Alert level three should be flagged
    let r = expectEvent('lateArrival', { routeIds: [routeInstance.id], timeAfter: 5 * 60000})
    let serviceStatuses = tool.processStatus(await tool.poll())

    expect(serviceStatuses[routeInstance.id].status.ping).below(3)
    expect(serviceStatuses[routeInstance.id].status.distance).equal(2)

    await r.check()
  })

  lab.test("Lite trips are continuously monitored", {timeout: 5000}, async function () {
    let now = Date.now()

    // create Route
    let routeInstance = await m.Route.create({
      name: "Test Lite Route",
      from: "From Lite",
      to: "To Lite",
      tags: ['notify-when-empty'], // Notify even if there are no passengers
    })

    const minsOffset = -60
    const tripStopsData = _(_.range(10)) // 10 cycles
      .map(cycle => [ // 5 stops per cycle, each cycle takes 25 minutes
        { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 25 * cycle + 0) * 60000)},
        { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 25 * cycle + 5) * 60000)},
        { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 25 * cycle + 10) * 60000)},

        { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 25 * cycle + 15) * 60000)},
        { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: new Date(now + (minsOffset + 25 * cycle + 20) * 60000)},
      ])
      .flatten()
      .value()

    // create some trips...
    let tripInstance = await m.Trip.create({
      date: new Date(now),
      capacity: 10,
      routeId: routeInstance.id,
      price: (Math.random() * 3 + 3).toFixed(2),
      transportCompanyId: companyInstance.id,
      tripStops: tripStopsData,
      bookingInfo: {
        windowType: 'stop',
        windowSize: 0,
      },
    }, {
      include: [{model: m.TripStop}],
    })

    // Say, the first ping was on time...
    await createPing(tripInstance, tripInstance.tripStops[0].time.getTime(), tripInstance.tripStops[0], 2000)

    // Subsequently, there were no pings.
    // Alert level four should be flagged
    let r = expectEvent('noPings', { routeIds: [routeInstance.id], minsBefore: [5] })
    let serviceStatuses = tool.processStatus(await tool.poll())
    expect(serviceStatuses[routeInstance.id].status.ping).least(4)
    await r.check()

    // Now create a ping. No alert should be flagged.
    // minsBefore is -60 ~ 12th stop
    await createPings(
      tripInstance,
      { date: tripInstance.tripStops[0].time.getTime(), tripStop: tripInstance.tripStops[0], distance: 2000 },
      { date: tripInstance.tripStops[12].time.getTime(), tripStop: tripInstance.tripStops[12], distance: 2000 }
    )
    serviceStatuses = tool.processStatus(await tool.poll())
    expect(serviceStatuses[routeInstance.id].status.ping).most(3)

    // one hour later, we should flag the trip again (check dedup does not
    // suppress noPings if it is 1 hour stale)
    try {
      timemachine.config({
        timestamp: tripInstance.tripStops[30].time.getTime(),
      })

      r = expectEvent('noPings', { routeIds: [routeInstance.id], minsBefore: [5] })
      serviceStatuses = tool.processStatus(await tool.poll())
      expect(serviceStatuses[routeInstance.id].status.ping).least(4)
      await r.check()

      // But deduplication should work now.
      r = expectEvent('noPings', { routeIds: [routeInstance.id], minsBefore: [5] })
      serviceStatuses = tool.processStatus(await tool.poll())
      expect(serviceStatuses[routeInstance.id].status.ping).least(4)
      await r.check()
        .then(() => fail(), () => {})
    } catch (e) {
      throw e
    } finally {
      timemachine.reset()
    }
  })
})
