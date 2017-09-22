var Lab = require("lab")
var lab = exports.lab = Lab.script()

var {expect} = require("code")
var Promise = require("promise")
var server = require("../src/index.js")
var querystring = require("querystring")

const {models} = require("../src/lib/core/dbschema")()
const {resetRegions} = require("../scripts/resetRegions")

var loginAs = require("./test_common").loginAs

lab.experiment("Route region manipulation", function () {
  var testName = "Name for Testing"
  var routeInfo = {
    name: testName,
    description: "Testing route description",
    path: JSON.stringify({testing: "testing"})
  }
  var regions = []

  // load the data...
  lab.before(async function () {
    regions = await resetRegions()
  })
  // destroy the regions...
  lab.after(async () => {
    await Promise.all(regions.map(reg => reg.destroy()))
  })

  lab.test("Routes/Region...", async function () {
    var companyInst = await models.TransportCompany.create({
      name: "Test route/region company"
    })
    var routeInst = await models.Route.create({
      name: "Test route/region",
      transportCompanyId: companyInst.id
    })

      // LOGIN
    var loginResp = await loginAs("admin", {
      transportCompanyId: companyInst.id,
      permissions: ['manage-routes']
    })
    var authHeaders = {
      authorization: "Bearer " + loginResp.result.sessionToken
    }

    var northStop = await models.Stop.create({
      coordinates: {
        type: "Point",
        coordinates: [103.792273, 1.429647]
      }
    })
    var northeastStop = await models.Stop.create({
      coordinates: {
        type: "Point",
        coordinates: [103.901863, 1.394185]
      }
    })
    var eastStop = await models.Stop.create({
      coordinates: {
        type: "Point",
        coordinates: [103.959603, 1.352047]
      }
    })

    var tripInst = await models.Trip.create({
      date: "2020-01-01", // -- FIXME: the route/region finder only looks are future trips
      transportCompanyId: companyInst.id,
      routeId: routeInst.id,
      tripStops: [
        {
          time: "2020-01-01T00:00:00Z",
          stopId: northStop.id
        },
        {
          time: "2020-01-01T00:00:00Z",
          stopId: northeastStop.id
        }
      ]
    }, {
      include: [models.TripStop]
    })

    // CHECK NORTH REGION
    var searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "North Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id)).to.include(routeInst.id)


    // CHECK NORTHEAST REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "North-east Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id)).to.include(routeInst.id)

    // CHECK SOUTH REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "South Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id))
      .to.not.include(routeInst.id)

    // DELETE, RECREATE
    await Promise.all(tripInst.tripStops.map(ts => ts.destroy()))
    await tripInst.destroy()
    tripInst = await models.Trip.create({
      date: "2020-01-01", // -- FIXME: the route/region finder only looks are future trips
      transportCompanyId: companyInst.id,
      routeId: routeInst.id,
      tripStops: [
        {
          time: "2020-01-01T00:00:00Z",
          stopId: eastStop.id
        },
        {
          time: "2020-01-01T00:00:00Z",
          stopId: northeastStop.id
        }
      ],
    }, {
      include: [models.TripStop]
    })


    // CHECK NORTH REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "North Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id))
      .to.not.include(routeInst.id)

    // CHECK NORTHEAST REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "North-east Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id))
      .to.include(routeInst.id)

    // CHECK EAST REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "East Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id)).to.include(routeInst.id)

    // CHECK SOUTH REGION
    searchResp = await server.inject({
      method: "GET",
      url: "/routes/search_by_region?" + querystring.stringify({
        areaName: "South Region"
      }),
      payload: routeInfo,
      headers: authHeaders
    })
    expect(searchResp.statusCode).to.equal(200)
    expect(searchResp.result.map(r => r.id)).to.not.include(routeInst.id)

    // clean up
    await Promise.all(tripInst.tripStops.map(ts => ts.destroy()))
    await tripInst.destroy()
    await Promise.all([
      eastStop.destroy(),
      northeastStop.destroy(),
      northStop.destroy()
    ])
    await Promise.all([
      routeInst.destroy()
    ])
  })
})
