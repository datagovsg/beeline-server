var Lab = require("lab")
var {expect} = require("code")
export var lab = Lab.script()

var server = require("../src/index.js")
const {models} = require("../src/lib/core/dbschema")()

var loginAs = require("./test_common").loginAs

lab.experiment("Driver manipulation", function () {
  var companyInstance

  lab.before({timeout: 10000}, async function () {
    companyInstance = await models.TransportCompany.create({
      name: "Test Transport Company"
    })
  })

  lab.after({timeout: 10000}, async function () {
    await companyInstance.destroy()
  })

  lab.test("CRUD Drivers", {timeout: 10000}, async function () {
    var response = await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['manage-drivers', 'view-drivers']
    })
    var sessionToken = response.result.sessionToken
    var authHeaders = {
      authorization: "Bearer " + sessionToken
    }

    await models.Driver.destroy({
      where: {
        telephone: '12345678'
      }
    })

    // Create a driver for this company
    response = await server.inject({
      method: "POST",
      url: `/companies/${companyInstance.id}/drivers`,
      payload: {
        name: "Test Driver!!",
        telephone: '12345678'
      },
      headers: authHeaders
    })
    var driver = response.result
    expect(driver).to.contain("id")
    expect(driver).to.not.contain('passwordHash')
    expect(driver).to.not.contain('authKey')
    expect(driver).to.not.contain('pairingCode')

    // Expect the driver to appear in the list
    response = await server.inject({
      method: 'GET',
      url: `/companies/${companyInstance.id}/drivers`,
      headers: authHeaders
    })
    expect(response.result.find(d => d.id === driver.id)).exist()

    response = await server.inject({
      method: "DELETE",
      url: `/companies/${companyInstance.id}/drivers/${driver.id}`,
      headers: authHeaders
    })
    expect(response.statusCode).to.equal(200)

    // Expect the driver to appear in the list
    response = await server.inject({
      method: 'GET',
      url: `/companies/${companyInstance.id}/drivers`,
      headers: authHeaders
    })
    expect(response.result.find(d => d.id === driver.id)).not.exist()
  })

  lab.test("Driver login", async function () {
    // Create a driver
    var telephone = '+6512344321'

    await models.Driver.destroy({
      where: {telephone}
    })
    var driverInst = await models.Driver.create({
      telephone,
      name: 'Ah Kow'
    })
    await driverInst.addTransportCompany(companyInstance.id)

    var sendResponse = await server.inject({
      method: "POST",
      url: "/drivers/sendTelephoneVerification?dryRun=true",
      payload: {telephone}
    })
    expect(sendResponse.statusCode).equal(200)

    // Extract code from database
    driverInst = await models.Driver.findById(driverInst.id)
    expect(driverInst.get('pairingCode', {raw: true})).exist()

    var loginResponse = await server.inject({
      method: 'POST',
      url: '/drivers/verifyTelephone',
      payload: {
        telephone,
        code: driverInst.get('pairingCode', {raw: true})
      }
    })
    expect(loginResponse.statusCode).equal(200)
    expect(loginResponse.result.sessionToken).exist()
    expect(loginResponse.result.driver).exist()
    expect(loginResponse.result.driver.id).equal(driverInst.id)
    expect(loginResponse.result.driver.name).equal('Ah Kow')

    var driverAuth = {
      authorization: `Bearer ${driverInst.makeToken()}`
    }

    // update driver's own details
    var putResponse = await server.inject({
      method: 'PUT',
      url: `/drivers/${driverInst.id}`,
      headers: driverAuth,
      payload: {
        name: 'Ah Seng'
      }
    })
    expect(putResponse.statusCode).equal(200)
    expect(putResponse.result.name).equal('Ah Seng')
  })
})
