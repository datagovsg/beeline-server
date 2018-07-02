/* eslint no-await-in-loop: 0 */
const Lab = require("lab")
export const lab = Lab.script()

const {expect} = require("code")
const server = require("../src/index.js")

const {models: m} = require("../src/lib/core/dbschema")()

lab.experiment("TripStatus manipulation", function () {
  const destroyList = []
  let driver
  let vehicle
  let trip
  let company

  lab.before({timeout: 10000}, async function () {
    company = await m.TransportCompany.create({
      name: "Test Transport Company",
    })
    destroyList.push(company)

    driver = await m.Driver.create({
      name: "Tan Ah Test",
      telephone: "12345678",
      authKey: "---",
      transportCompanyId: company.id,
    })
    await driver.addTransportCompany(company)
    destroyList.push(driver)

    vehicle = await m.Vehicle.create({
      vehicleNumber: "SXX0000Y",
      driverId: driver.id,
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
      routeId: null,
    })
    destroyList.push(trip)
  })

  lab.after(async function () {
    for (let it of destroyList.reverse()) {
      await it.destroy()
    }
  })

  lab.test("Create tripStatuses", async function () {
    const authHeaders = {
      authorization: `Bearer ${driver.makeToken()}`,
    }

    const messages = ["OK", "+5min", "+15min", "+30min"]

    // Trip status can be updated by the driver,
    // provided he is the driver for the trip
    trip.driverId = driver.id
    await trip.save()

    // create some tripStatuses...
    for (let message of messages) {
      const response = await server.inject({
        method: "POST",
        url: `/trips/${trip.id}/messages`,
        payload: {
          message,
        },
        headers: authHeaders,
      })
      const tripStatus = response.result
      expect(response.statusCode).to.equal(200)
      expect(tripStatus.message).to.exist()
      expect(tripStatus.time).to.exist()
      expect(tripStatus.creator).to.exist()
    }

    // GET tripStatuses?
    const response = await server.inject({
      method: "GET",
      url: `/trips/${trip.id}/statuses`,
    })
    for (let message of messages) {
      expect(response.result.map(x => x.message)).to.include(message)
    }
    expect(response.result.length).to.equal(messages.length)

    await server.inject({
      method: "POST",
      url: `/trips/${trip.id}/messages`,
      payload: {
        message: "cancel",
        status: "cancelled",
      },
      headers: authHeaders,
    })

    const { result } = await server.inject({
      method: "GET",
      url: `/trips/${trip.id}`,
    })
    expect(result.status).to.equal("cancelled")
    for (let message of messages) {
      expect(result.messages.map(x => x.message)).to.include(message)
    }

  })
})
