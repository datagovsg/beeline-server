var Lab = require("lab")
var lab = exports.lab = Lab.script()

var {expect} = require("code")
var server = require("../src/index.js")
var _ = require("lodash")

var {loginAs} = require("./test_common")
const {models} = require("../src/lib/core/dbschema")()

lab.experiment("Region manipulation", function () {
  var authHeaders
  var testName = "Name for Testing"
  var updatedTestName = "Updated name for Testing"

  var regionId = null
  var regionInfo = {
    areaName: "Area Name!",
    name: testName
  }
  var updatedRegionInfo = {
    areaName: "xArea Name!",
    name: updatedTestName,
    id: 12345
  }

  lab.test("CRUD operations", async function (done) {
    // LOGIN
    var resp = await loginAs('superadmin')
    expect(resp.statusCode).to.equal(200)
    authHeaders = {
      authorization: "Bearer " + resp.result.sessionToken
    }
    // CREATE
    resp = await server.inject({
      method: "POST",
      url: "/regions",
      payload: regionInfo,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")

    expect(_.isMatch(resp.result, regionInfo)).true()
    regionId = resp.result.id
    // READ
    resp = await server.inject({
      method: "GET",
      url: "/regions/" + regionId
    })
    expect(resp.statusCode).to.equal(200)
    expect(_.isMatch(resp.result, regionInfo)).true()

    // UPDATE
    resp = await server.inject({
      method: "PUT",
      url: "/regions/" + regionId,
      headers: authHeaders,
      payload: updatedRegionInfo
    })
    expect(resp.statusCode).to.equal(200)
    delete updatedRegionInfo.id
    expect(_.isMatch(resp.result, updatedRegionInfo)).true()
    resp = await server.inject({
      method: "GET",
      url: "/regions/" + regionId
    })
    expect(_.isMatch(resp.result, updatedRegionInfo)).true()

    // DELETE
    resp = await server.inject({
      method: "DELETE",
      url: "/regions/" + regionId,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)

    resp = await server.inject({
      method: "GET",
      url: "/regions/" + regionId
    })
    expect(resp.statusCode).to.equal(404)
  })

  lab.test("Predefined regions exist in database", async (done) => {
    var predefinedRegions = await models.Region.findAll({
      where: {
        polygon: {$not: null}
      }
    })

    expect(predefinedRegions.length).above(50)
  })
})
