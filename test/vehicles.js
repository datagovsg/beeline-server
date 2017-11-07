var Lab = require("lab")
export var lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index")

const {models: m} = require("../src/lib/core/dbschema")()

lab.experiment("Vehicle manipulation", function () {
  var destroyList = []
  lab.before({timeout: 10000}, async function () {
  })

  lab.after({timeout: 10000}, async function () {
    for (let it of destroyList.reverse()) {
      await it.destroy() // eslint-disable-line no-await-in-loop
    }
  })

  lab.test("Pair vehicle", async function () {
    var companyInstance = await m.TransportCompany.create({
      name: "Test Transport Company"
    })
    destroyList.push(companyInstance)

    var driver = await m.Driver.create({
      name: "Tan Ah Test",
      telephone: "12345678",
      authKey: "---",
    })
    await driver.addTransportCompany(companyInstance.id)
    destroyList.push(driver)

    var authHeaders = {
      authorization: `Bearer ${driver.makeToken()}`
    }

    var response = await server.inject({
      method: "POST",
      url: "/vehicles",
      payload: {
        vehicleNumber: "SAB1234X"
      },
      headers: authHeaders
    })
    var vehicle = response.result
    expect(response.statusCode).to.equal(200)
    expect(vehicle).to.contain("id")
    expect(vehicle.driverId).to.equal(driver.id)

    // No duplicates!
    response = await server.inject({
      method: "POST",
      url: "/vehicles",
      payload: {
        vehicleNumber: "SAB1234X"
      },
      headers: authHeaders
    })
    expect(response).to.not.equal(200)

    // Update is not strictly speaking necessary is it?
    // FIXME: HAPI does not support testing file upload
    //            var identicon = Identicon.generateSync({
    //                id: 'RandomTest' + Math.random(),
    //                size: 100,
    //            });
    //            var response = await server.inject({
    //                method: 'POST',
    //                url: '/vehicles/' + vehicle.id + '/photo',
    //                payload: {
    //
    //                },
    //
    //            });

    // Delete
    response = await server.inject({
      method: "DELETE",
      url: "/vehicles/" + vehicle.id,
      headers: authHeaders
    })
    vehicle = response.result
    expect(response.statusCode).to.equal(200)
  })
})
