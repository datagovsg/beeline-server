/* eslint no-await-in-loop: 0 */
var Lab = require("lab")
export var lab = Lab.script()

import {expect} from "code"
import sinon from "sinon"

import _ from 'lodash'
import qs from "querystring"
import axios from "axios"

const server = require("../src/index.js")

const {models: m} = require("../src/lib/core/dbschema")()

lab.experiment("Ping manipulation", function () {
  var destroyList = []
  var driver, vehicle, trip, company

  lab.before({timeout: 10000}, async function () {
    company = await m.TransportCompany.create({
      name: "Test Transport Company"
    })
    destroyList.push(company)

    driver = await m.Driver.create({
      name: "Tan Ah Test",
      telephone: "12345678",
    })
    await driver.addTransportCompany(company.id)
    destroyList.push(driver)

    vehicle = await m.Vehicle.create({
      vehicleNumber: "SXX0000Y",
      driverId: driver.id
    })
    destroyList.push(vehicle)

    const route = await m.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To",
      transportCompanyId: company.id,
      label: 'XYZ'
    })
    destroyList.push(route)

    trip = await m.Trip.create({
      date: "2015-04-04",
      capacity: 1,
      status: "TESTING",
      price: "1.00",
      routeId: route.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
    })
    destroyList.push(trip)
  })

  lab.after(async function () {
    for (let it of destroyList.reverse()) {
      await it.destroy()
    }
    destroyList = []
  })

  lab.test("Create pings", async function () {
    var authHeaders = {
      authorization: `Bearer ${driver.makeToken()}`
    }

    // create some pings...
    for (var i = 0; i < 10; i++) {
      var response = await server.inject({
        method: "POST",
        url: "/trips/" + trip.id + "/pings",
        payload: {
          vehicleId: vehicle.id
        },
        headers: authHeaders
      })
      var ping = response.result
      expect(response.statusCode).to.equal(200)
      expect(ping).to.contain("id")
    }

    // GET pings?
    response = await server.inject({
      method: "GET",
      url: "/trips/" + trip.id + "/pings"
    })
    expect(response.result.length).to.equal(10)
  })

  lab.test("Query pings by time", async function () {
    // create some pings...
    var time = new Date("2015-10-01T05:00:00Z").getTime()
    for (var i = 0; i < 100; i++) {
      destroyList.push(await m.Ping.create({
        driverId: driver.id,
        vehicleId: vehicle.id,
        tripId: trip.id,
        time: new Date(time + i * 10000)
      }))
    }

    // GET pings?
    var response = await server.inject({
      method: "GET",
      url: "/trips/" + trip.id + "/pings?" +
                            qs.stringify({
                              startTime: "2015-10-01T04:59:59Z",
                              endTime: "2015-10-01T05:01:59Z"
                            })
    })
    expect(response.result.length).to.equal(12)
  })

  lab.test("Overall trip status", async function () {
    // create some pings...
    // find the latest time...
    var latestPing = await m.Ping.find({
      where: {
        tripId: trip.id,
        vehicleId: vehicle.id
      },
      order: [["time", "DESC"]],
      limit: 1
    })
    var latestTime = latestPing ? latestPing.time : new Date()

    var pingInstances = _.range(0, 10)
      .map(i => m.Ping.create({
        vehicleId: vehicle.id,
        driverId: vehicle.driverId,
        tripId: trip.id,
        time: new Date(latestTime.getTime() + 60000 * i)
      }))
    pingInstances = await Promise.all(pingInstances)

    // create some statuses
    var latestStatus = await m.TripStatus.find({
      where: {
        tripId: trip.id
      },
      order: [["time", "DESC"]],
      limit: 1
    })
    latestTime = latestStatus ? latestStatus.time : new Date()
    var statusInstances = _.range(0, 10)
      .map(i => m.TripStatus.create({
        time: new Date(latestTime.getTime() + 60000 * i),
        tripId: trip.id,
        status: "status " + i
      }))
    statusInstances = await Promise.all(statusInstances)

    // GET pings?
    var response = await server.inject({
      method: "GET",
      url: "/trips/" + trip.id + "/latestInfo"
    })
    expect(response.result).to.include("trip")
    expect(response.result.trip.transportCompany).exist()
    expect(response.result.trip.tripDriver).exist()
    expect(response.result).to.include("pings")
    expect(response.result).to.include("statuses")
    expect(response.result).to.include("code")

    expect(response.result.pings[0].id).to.equal(pingInstances[9].id)
    expect(response.result.statuses[0].id).to.equal(statusInstances[9].id)
  })

  lab.test("Ping is forwarded if TRACKING_URL set", async function () {
    process.env.TRACKING_URL = 'https://mockurl.com'
    const mockPost = sinon.stub(axios, 'post')
    mockPost.returns({ catch: () => {} })

    const payload = {
      vehicleId: vehicle.id,
      latitude: 1,
      longitude: 103,
    }
    const headers = {
      authorization: `Bearer ${driver.makeToken()}`
    }

    try {
      await server.inject({
        method: "POST",
        url: `/trips/${trip.id}/pings`,
        payload,
        headers,
      })
      expect(mockPost.calledOnce).true()
      expect(mockPost.args[0]).equal([
        `${process.env.TRACKING_URL}/trips/${trip.id}/pings/latest`,
        payload,
        { headers }
      ])
    } finally {
      delete process.env.TRACKING_URL
      mockPost.restore()
    }
  })

  lab.test("Ping not forwarded if TRACKING_URL unset", async function () {
    const mockPost = sinon.stub(axios, 'post')
    mockPost.returns({ catch: () => {} })

    const payload = {
      vehicleId: vehicle.id,
      latitude: 1,
      longitude: 103,
    }
    const headers = {
      authorization: `Bearer ${driver.makeToken()}`
    }

    try {
      await server.inject({
        method: "POST",
        url: `/trips/${trip.id}/pings`,
        payload,
        headers,
      })
      expect(mockPost.called).false()
    } finally {
      delete process.env.TRACKING_URL
      mockPost.restore()
    }
  })
})
