var Lab = require("lab")
export var lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index.js")
var common = require("../src/lib/util/common")
const {db, models: m} = require("../src/lib/core/dbschema")()

import _ from 'lodash'
import {loginAs, defaultErrorHandler} from './test_common'
import qs from "querystring"
import uuid from "uuid"

lab.experiment("Suggestion manipulation", function () {
  var authHeaders
  var destroyList = []
  var user, vehicle, trip, company
  var authHeaders

  lab.before({timeout: 10000}, async function () {
    user = await m.User.create({
      name: "My Test User",
      password: "TestingPassword"
    })
    authHeaders = {
      authorization: `Bearer ${user.makeToken()}`
    }
    destroyList.push(user)
  })

  lab.after(async function () {
    for (let it of destroyList.reverse()) {
      await it.destroy()
    }
    destroyList = []
  })

  lab.test("CRUD suggestions", async function () {
      // create some suggestions...
    var suggestions = [
      await server.inject({
        url: "/suggestions",
        headers: authHeaders,
        method: "POST",
        payload: {
          boardLat: 1.2,
          boardLon: 103.1,
          alightLat: 1.4,
          alightLon: 104.0,
          time: 7 * 3600 + 30 * 60
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: authHeaders,
        method: "POST",
        payload: {
          boardLat: 1.21,
          boardLon: 103.2,
          alightLat: 1.39,
          alightLon: 103.9,
          time: 8 * 3600 + 0 * 60
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: authHeaders,
        method: "POST",
        payload: {
          boardLat: 1.22,
          boardLon: 103.3,
          alightLat: 1.38,
          alightLon: 103.8,
          time: 8 * 3600 + 30 * 60
        }
      })
    ]

    for (let sugg of suggestions) {
      expect(sugg.statusCode).to.equal(200)
    }

      // Get all suggestions
    var getSuggestions = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: authHeaders
    })
    expect(getSuggestions.statusCode).to.equal(200)
    for (let sugg of suggestions) {
      expect(suggestions.map(s => s.result.id)).to.include(sugg.result.id)
    }

      // Ensure PUT works
    var sid = suggestions[0].result.id
    var putData = {
      boardLat: 1.38,
      boardLon: 103.8,
      alightLat: 1.39,
      alightLon: 103.71,
      time: 6 * 3600
    }
    var putResult = await server.inject({
      method: "PUT",
      url: "/suggestions/" + sid,
      headers: authHeaders,
      payload: putData
    })
    expect(putResult.statusCode).to.equal(200)
    var afterPut = await server.inject({
      method: "GET",
      url: "/suggestions/" + sid,
      headers: authHeaders
    })
    expect(afterPut.statusCode).to.equal(200)
    expect(afterPut.result.board.coordinates[0]).to.equal(putData.boardLon)
    expect(afterPut.result.board.coordinates[1]).to.equal(putData.boardLat)
    expect(afterPut.result.alight.coordinates[0]).to.equal(putData.alightLon)
    expect(afterPut.result.alight.coordinates[1]).to.equal(putData.alightLat)
    expect(afterPut.result.time).to.equal(putData.time)

      // Ensure delete works
    for (let sugg of suggestions) {
      var sid = sugg.result.id
      var delResult = await server.inject({
        method: "DELETE",
        url: "/suggestions/" + sid,
        headers: authHeaders
      })
      expect(delResult.statusCode).to.equal(200)
    }

      // Get all suggestions
    var getSuggestions = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: authHeaders
    })
    expect(getSuggestions.statusCode).to.equal(200)
    for (let sugg of suggestions) {
      expect(suggestions.map(s => s.id)).to.not.include(sugg.result.id)
    }
  })

  lab.test("CRUD anonymous suggestions", async function () {
    var anonHeaders = {
      "Beeline-Device-UUID": uuid.v4()
    }

      // create some suggestions...
    var suggestions = [
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.2,
          boardLon: 103.1,
          alightLat: 1.4,
          alightLon: 104.0,
          time: 7 * 3600 + 30 * 60
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.21,
          boardLon: 103.2,
          alightLat: 1.39,
          alightLon: 103.9,
          time: 8 * 3600 + 0 * 60,
          referrer: 'ABC'
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.22,
          boardLon: 103.3,
          alightLat: 1.38,
          alightLon: 103.8,
          time: 8 * 3600 + 30 * 60,
          referrer: 'XYZ'
        }
      })
    ]

    for (let sugg of suggestions) {
      expect(sugg.statusCode).to.equal(200)
    }

    let referrers = suggestions.map(x => x.result.referrer)
    expect(referrers).to.include([null, 'ABC', 'XYZ'])


      // Get all suggestions
    var getSuggestions = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: anonHeaders
    })
    expect(getSuggestions.statusCode).to.equal(200)
    for (let sugg of suggestions) {
      expect(suggestions.map(s => s.result.id)).to.include(sugg.result.id)
    }

      // Ensure PUT works
    var sid = suggestions[0].result.id
    var putData = {
      boardLat: 1.38,
      boardLon: 103.8,
      alightLat: 1.39,
      alightLon: 103.71,
      time: 6 * 3600
    }
    var putResult = await server.inject({
      method: "PUT",
      url: "/suggestions/" + sid,
      headers: anonHeaders,
      payload: putData
    })
    expect(putResult.statusCode).to.equal(200)
    var afterPut = await server.inject({
      method: "GET",
      url: "/suggestions/" + sid,
      headers: anonHeaders
    })
    expect(afterPut.statusCode).to.equal(200)
    expect(afterPut.result.board.coordinates[0]).to.equal(putData.boardLon)
    expect(afterPut.result.board.coordinates[1]).to.equal(putData.boardLat)
    expect(afterPut.result.alight.coordinates[0]).to.equal(putData.alightLon)
    expect(afterPut.result.alight.coordinates[1]).to.equal(putData.alightLat)
    expect(afterPut.result.time).to.equal(putData.time)

      // Ensure delete works
    for (let sugg of suggestions) {
      var sid = sugg.result.id
      var delResult = await server.inject({
        method: "DELETE",
        url: "/suggestions/" + sid,
        headers: anonHeaders
      })
      expect(delResult.statusCode).to.equal(200)
    }

      // Get all suggestions
    var getSuggestions = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: anonHeaders
    })
    expect(getSuggestions.statusCode).to.equal(200)
    for (let sugg of suggestions) {
      expect(suggestions.map(s => s.id)).to.not.include(sugg.result.id)
    }
  })

  lab.test("No suggestions when anonymous", async function () {
    var anonHeaders = {
      "Beeline-Device-UUID": uuid.v4()
    }
    var response1 = await server.inject({
      url: "/suggestions",
      headers: anonHeaders,
      method: "POST",
      payload: {
        boardLat: 1.2,
        boardLon: 103.1,
        alightLat: 1.4,
        alightLon: 104.0,
        time: 7 * 3600 + 30 * 60
      }
    })
    expect(response1.statusCode).to.equal(200)

    var response2 = await server.inject({
      url: "/suggestions",
      headers: {},
      method: "GET"
    })
    expect(response2.statusCode).to.equal(200)
    expect(response2.result.length).to.equal(0)
  })


  lab.test("Deanonymize suggestions", async function () {
    var anonHeaders = {
      "Beeline-Device-UUID": uuid.v4()
    }

      // create some suggestions...
    var suggestionsResp = [
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.2,
          boardLon: 103.1,
          alightLat: 1.4,
          alightLon: 104.0,
          time: 7 * 3600 + 30 * 60
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.21,
          boardLon: 103.2,
          alightLat: 1.39,
          alightLon: 103.9,
          time: 8 * 3600 + 0 * 60
        }
      }),
      await server.inject({
        url: "/suggestions",
        headers: anonHeaders,
        method: "POST",
        payload: {
          boardLat: 1.22,
          boardLon: 103.3,
          alightLat: 1.38,
          alightLon: 103.8,
          time: 8 * 3600 + 30 * 60
        }
      })
    ]

    for (let sugg of suggestionsResp) {
      expect(sugg.statusCode).to.equal(200)
    }

      // Convert anonymous to non-anonymous
    var authResponse = await loginAs("user", {userId: user.id}, server)
    var sessionToken = authResponse.result.sessionToken
    var userHeaders = _.assign({}, authHeaders, anonHeaders)

    await server.inject({
      url: "/suggestions/deanonymize",
      method: "POST",
      headers: userHeaders
    })

      // get the suggestions belonging to this user
    var userSuggestions = await m.Suggestion.findAll({
      where: {
        userId: user.id
      }
    })
    destroyList = destroyList.concat(userSuggestions)

      // ensure that the anonymous suggestions have been converted
    var userSuggestionIds = userSuggestions.map(sugg => sugg.id)
    for (let sugg of suggestionsResp) {
      expect(userSuggestionIds).to.include(sugg.result.id)
    }
  })
})
