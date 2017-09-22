const Lab = require("lab")
export const lab = Lab.script()
const {expect} = require("code")
const server = require("../src/index.js")
const {models: m} = require("../src/lib/core/dbschema")()
const _ = require("lodash") // from 'lodash'
const {randomSingaporeLngLat, randomEmail, suggestionToken} = require("./test_common")
const sinon = require('sinon')

lab.experiment("User Suggested Routes", function () {
  let sandbox

  lab.beforeEach(async () => {
    sandbox = sinon.sandbox.create()
  })

  lab.afterEach(async () => {
    sandbox.restore()
  })

  lab.test("Create/delete User-suggested Routes", {timeout: 5000}, async function () {
    const lngLats = _.range(0, 10).map(_ => randomSingaporeLngLat())
    const name = 'My Name'
    const email = randomEmail()

    const stopInstances = await Promise.all(lngLats.map((lngLat, index) => m.Stop.create({
      description: `Random Stop ${index}`,
      coordinates: {
        type: 'Point',
        coordinates: lngLat
      }
    })))

    const createResponse = await server.inject({
      url: '/modules/user_suggestions/routes',
      method: 'POST',
      payload: {
        name,
        busStops: lngLats.map((lngLat, index) => ({
          coordinates: {
            type: 'Point',
            coordinates: lngLat,
          },
          arriveAt: (6 + index * 0.1) * 3600 * 1000
        })),
        path: {
          type: 'LineString',
          coordinates: lngLats
        },
      },
      headers: {
        authorization: 'Bearer ' + suggestionToken(email)
      }
    })

    expect(createResponse.statusCode).equal(200)
    expect(createResponse.result.userSuggestedRouteStops.length).equal(lngLats.length)

    for (let [usrs, stop] of _.zip(createResponse.result.userSuggestedRouteStops, stopInstances)) {
      expect(usrs.stopId).equal(stop.id)
    }

    const getResponse = await server.inject({
      url: '/modules/user_suggestions/routes',
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + suggestionToken(email)
      }
    })
    expect(getResponse.result.length).equal(1)
    expect(getResponse.result[0].name).equal(name)
    expect(getResponse.result[0].path.coordinates).equal(lngLats)
    expect(getResponse.result[0].userSuggestedRouteStops.length).equal(lngLats.length)
    expect(_.sortBy(getResponse.result[0].userSuggestedRouteStops, 'arriveAt'))
      .equal(getResponse.result[0].userSuggestedRouteStops)
    expect(getResponse.result[0].id).equal(createResponse.result.id)

    const deleteResponse = await server.inject({
      url: `/modules/user_suggestions/routes/${getResponse.result[0].id}`,
      method: 'DELETE',
      headers: {
        authorization: 'Bearer ' + suggestionToken(email)
      }
    })
    expect(deleteResponse.statusCode).equal(200)
    expect(await m.UserSuggestedRouteStop.findById(getResponse.result[0].id)).not.exist()
  })
})
