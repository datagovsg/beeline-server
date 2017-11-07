/* eslint no-await-in-loop: 0 */
var Lab = require("lab")
export var lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index.js")

const {models: m} = require("../src/lib/core/dbschema")()

lab.experiment("TripStatus manipulation", function () {
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
      authKey: "---",
      transportCompanyId: company.id
    })
    await driver.addTransportCompany(company)
    destroyList.push(driver)

    vehicle = await m.Vehicle.create({
      vehicleNumber: "SXX0000Y",
      driverId: driver.id
    })
    destroyList.push(vehicle)

    trip = await m.Trip.create({
      date: "2015-04-04",
      capacity: 1,
      status: "TESTING",
      price: "1.00",
      transportCompanyId: company.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
      routeId: null
    })
    destroyList.push(trip)
  })

  lab.after(async function () {
    for (let it of destroyList.reverse()) {
      await it.destroy()
    }
    destroyList = []
  })

  lab.test("Create tripStatuses", async function () {
    var authHeaders = {
      authorization: `Bearer ${driver.makeToken()}`
    }

    var statuses = ["OK", "+5min", "+15min", "+30min"]

    // Trip status can be updated by the driver,
    // provided he is the driver for the trip
    trip.driverId = driver.id
    await trip.save()

    // create some tripStatuses...
    for (let status of statuses) {
      var response = await server.inject({
        method: "POST",
        url: "/trips/" + trip.id + "/statuses",
        payload: {
          status: status
        },
        headers: authHeaders
      })
      var tripStatus = response.result
      expect(response.statusCode).to.equal(200)
      expect(tripStatus).to.contain("id")
      expect(tripStatus.time).to.exist()
      expect(tripStatus.creator).to.exist()
    }

    // GET tripStatuses?
    response = await server.inject({
      method: "GET",
      url: "/trips/" + trip.id + "/statuses"
    })
    for (let status of statuses) {
      expect(response.result.map(x => x.status)).to.include(status)
    }
    expect(response.result.length).to.equal(statuses.length)
  })
})
