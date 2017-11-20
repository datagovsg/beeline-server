var Lab = require("lab")
var lab = exports.lab = Lab.script()

const {expect} = require("code")
var _ = require("lodash")

const {models: m} = require("../src/lib/core/dbschema")()
const server = require("../src/index.js")
const {loginAs} = require("./test_common")
const {createUsersCompaniesRoutesAndTrips} = require('./test_data')

lab.experiment("Stop manipulation", async () => {
  var testName = "Name for Testing"
  var updatedTestName = "Updated name for Testing"

  var stopId
  var stopInfo = {
    description: testName,
    road: "Testing road name",
    postcode: "Testing postcode",
    type: "Testing stop type",
    coordinates: { type: "Point", coordinates: [103.76073, 1.317370] }
  }
  var updatedStopInfo = {
    description: updatedTestName,
    road: "xTesting road name",
    postcode: "xTesting postcode",
    type: "xTesting stop type",
    coordinates: { type: "Point", coordinates: [103.99102, 1.350199] }
  }
  await m.TransportCompany.create({})
  const authHeaders = await loginAs("superadmin")
    .then(resp => {
      return { authorization: "Bearer " + resp.result.sessionToken }
    })

  lab.test("CRUD integration test", {timeout: 15000}, async () => {
    // CREATE
    var resp = await server.inject({
      method: "POST",
      url: "/stops",
      payload: stopInfo,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")

    expect(_.isMatch(resp.result, stopInfo)).true()
    stopId = resp.result.id

    // READ
    resp = await server.inject({
      method: "GET",
      url: "/stops/" + stopId
    })
    expect(resp.statusCode).to.equal(200)
    expect(_.isMatch(resp.result, stopInfo)).true()

    // BULK READ
    resp = await server.inject({
      method: "GET",
      url: "/stops"
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result.reduce(
      (current, stop) => current || _.isMatch(stop, stopInfo),
      false
    )).true()

    // UPDATE
    resp = await server.inject({
      method: "PUT",
      url: "/stops/" + stopId,
      headers: authHeaders,
      payload: updatedStopInfo
    })
    expect(resp.statusCode).to.equal(200)
    delete updatedStopInfo.id
    expect(resp.result.id).to.equal(stopId)
    expect(_.isMatch(resp.result, updatedStopInfo)).true()

    resp = await server.inject({
      method: "GET",
      url: "/stops/" + stopId
    })
    expect(_.isMatch(resp.result, updatedStopInfo)).true()

    // DELETE
    resp = await server.inject({
      method: "DELETE",
      url: "/stops/" + stopId,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(_.isMatch(resp.result, updatedStopInfo)).true()

    resp = await server.inject({
      method: "GET",
      url: "/stops/" + stopId
    })
    expect(resp.statusCode).to.equal(404)
  })

  lab.test('should throw a 500 on hitting trip stops constraint errors', {timeout: 15000}, async () => {
    const {stopInstances} = await createUsersCompaniesRoutesAndTrips(m)

    const stopId = stopInstances[0].id

    const resp = await server.inject({
      method: "DELETE",
      url: "/stops/" + stopId,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(500)
  })
})
