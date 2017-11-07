var Lab = require("lab")
export var lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index.js")
var common = require("../src/lib/util/common")

const {db, models: m} = require("../src/lib/core/dbschema")()
import _ from 'lodash'
import {loginAs, defaultErrorHandler} from './test_common'

lab.experiment("Vehicle manipulation", function () {
  var authHeaders

  lab.before({timeout: 10000}, async function () {
  })

  lab.test("Pair vehicle", async function () {
    var destroyList = []
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
    var response = await server.inject({
      method: "POST",
      url: "/vehicles",
      payload: {
        vehicleNumber: "SAB1234X"
      },
      headers: authHeaders
    })
    var vehicle2 = response.result
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
    var response = await server.inject({
      method: "DELETE",
      url: "/vehicles/" + vehicle.id,
      headers: authHeaders
    })
    var vehicle = response.result
    expect(response.statusCode).to.equal(200)

    for (let it of destroyList.reverse()) {
      await it.destroy()
    }
  })
})
