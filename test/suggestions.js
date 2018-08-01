import Lab from "lab"
import {expect} from "code"
import _ from 'lodash'
import querystring from 'querystring'
import { loginAs, randomEmail } from "./test_common.js"
import Joi from '../src/lib/util/joi'

const server = require("../src/index.js")
const {models: m} = require("../src/lib/core/dbschema")()

export const lab = Lab.script()

lab.experiment("Suggestion manipulation", function () {
  let userHeaders
  let superadminHeaders
  let user, user2

  const makeTime = (hour, minutes) => hour * 3600e3 + minutes * 60e3

  lab.before({timeout: 10000}, async function () {
    user = await m.User.create({
      name: "My Test User",
      email: randomEmail(),
      emailVerified: true,
    })
    user2 = await m.User.create({
      name: "My Test User",
      email: randomEmail(),
      emailVerified: true,
    })
    userHeaders = {
      authorization: `Bearer ${user.makeToken()}`,
    }
    superadminHeaders = {
      authorization: `Bearer ` + (await loginAs("superadmin", {email: 'test@data.gov.sg'}))
        .result.sessionToken,
    }

    // Empty the table
    await m.Suggestion.truncate()
  })

  lab.test("Create and fetch suggestions", async () => {
    // Create suggestions
    let suggestionsData = [
      {
        board: {lat: 1.2, lng: 103.1},
        alight: {lat: 1.4, lng: 104.0},
        time: makeTime(7, 30),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.21, lng: 103.2},
        alight: {lat: 1.39, lng: 103.9},
        time: makeTime(8, 0),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.22, lng: 103.3},
        alight: {lat: 1.38, lng: 103.8},
        time: makeTime(8, 30),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
    ]

    // Create suggestions
    const responses = await Promise.all(suggestionsData.map(
      (payload) => server.inject({
        url: "/suggestions",
        headers: userHeaders,
        method: "POST",
        payload,
      })))

    for (let response of responses) {
      expect(response.statusCode).equal(200)
    }

    let suggestionsInDatabase = await m.Suggestion.findAll()
    for (let [response, suggestion] of _.zip(responses, suggestionsInDatabase)) {
      expect(suggestion.userId).equal(response.result.userId)
    }

    // Single fetch
    const singleResult = await server.inject({
      url: `/suggestions/${responses[0].result.id}`,
      headers: userHeaders,
      method: 'GET',
    })
    expect(singleResult.result.alight.coordinates[0]).equal(104.0)
    expect(singleResult.result.board.coordinates[0]).equal(103.1)

    // Fetch personal suggestions
    const superadminFetchPersonalResponse = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: userHeaders,
    })
    expect(superadminFetchPersonalResponse.result.length).equal(3)
    expect(superadminFetchPersonalResponse.result.every(r => r.userId === user.id))

    // User 2 fetch personal suggestions --> no results
    const user2FetchPersonalResponse = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: {Authorization: `Bearer ${user2.makeToken()}`},
    })
    expect(user2FetchPersonalResponse.result.length).equal(0)

    // Superadmin fetch all suggestions
    const superadminFetchResponse = await server.inject({
      url: "/all_suggestions",
      method: "GET",
      headers: superadminHeaders,
    })
    expect(superadminFetchResponse.result.length).equal(3)
    expect(superadminFetchResponse.result.every(r => r.userId === user.id))

    // User 2 fetch all suggestions
    const user2FetchResponse = await server.inject({
      url: "/all_suggestions",
      method: "GET",
      headers: {Authorization: `Bearer ${user2.makeToken()}`},
    })
    expect(user2FetchResponse.result.length).equal(3)
    expect(user2FetchResponse.result.every(r => r.userId !== user.id))

    // Last ID fetch
    const maxId = _.max(responses.map(r => r.result.id))
    const lastIdFetchResponse = await server.inject({
      url: "/all_suggestions?" + querystring.stringify({
        lastId: maxId,
      }),
      method: "GET",
      headers: userHeaders,
    })
    expect(lastIdFetchResponse.result.length).equal(2)
    expect(lastIdFetchResponse.result.every(r => r.id < maxId)).true()
    expect(lastIdFetchResponse.result.every(r => r.userId === user.id)).true()
  })

  lab.test("Update and delete suggestions", async () => {
    const suggestion = await m.Suggestion.create({
      userId: user.id,
      board: Joi.attempt({lat: 1.3, lng: 103.8}, Joi.latlng()),
      alight: Joi.attempt({lat: 1.35, lng: 103.75}, Joi.latlng()),
      time: makeTime(6, 45),
      daysOfWeek: {
        Mon: true,
        Tue: true,
        Wed: true,
        Thu: true,
        Fri: true,
        Sat: false,
        Sun: false,
      },
    })

    const putResponse = await server.inject({
      url: `/suggestions/${suggestion.id}`,
      method: 'PUT',
      headers: userHeaders,
      payload: {
        board: {lat: 1.4, lng: 103.9},
        alight: {lat: 1.3, lng: 103.8},
        time: makeTime(6, 50),
        daysOfWeek: {
          Mon: false,
          Tue: false,
          Wed: false,
          Thu: false,
          Fri: false,
          Sat: true,
          Sun: true,
        },
      },
    })
    expect(putResponse.statusCode).equal(200)

    await suggestion.reload()

    expect(suggestion.board.coordinates[1]).equal(1.4)
    expect(suggestion.alight.coordinates[1]).equal(1.3)
    expect(suggestion.time).equal(makeTime(6, 50))
    expect(suggestion.daysOfWeek.Sat).equal(true)
    expect(suggestion.daysOfWeek.Sun).equal(true)

    const deleteResponse = await server.inject({
      url: `/suggestions/${suggestion.id}`,
      method: 'DELETE',
      headers: userHeaders,
    })
    expect(deleteResponse.statusCode).equal(200)

    expect(await m.Suggestion.findById(suggestion.id)).null()

    expect((await server.inject({
      url: `/suggestions/${suggestion.id}`,
      method: 'GET',
    })).statusCode).equal(404)
  })

  lab.test("Deanonymize suggestions", async function () {
    const suggestion = await m.Suggestion.create({
      userId: null,
      email: user.email,
      board: Joi.attempt({lat: 1.3, lng: 103.8}, Joi.latlng()),
      alight: Joi.attempt({lat: 1.35, lng: 103.75}, Joi.latlng()),
      time: makeTime(6, 45),
      daysOfWeek: {
        Mon: true,
        Tue: true,
        Wed: true,
        Thu: true,
        Fri: true,
        Sat: false,
        Sun: false,
      },
    })

    // create some suggestions...
    const deanonymizeResponse = await server.inject({
      url: "/suggestions/deanonymize",
      headers: userHeaders,
      method: "POST",
    })
    expect(deanonymizeResponse.statusCode).equal(200)

    await suggestion.reload()
    expect(suggestion.userId).equal(user.id)
  })

  lab.test("Suggest days mask", async function () {
    const geojsonPoint = (lnglat) => ({type: 'Point', coordinates: lnglat})
    const suggestionSetByInt = await m.Suggestion.create({
      board: geojsonPoint([103.8, 1.38]),
      alight: geojsonPoint([103.9, 1.39]),
      time: makeTime(8, 0),
      daysMask: parseInt('1010111', 2),
    })

    expect(suggestionSetByInt.daysOfWeek).to.equal({
      Mon: true,
      Tue: true,
      Wed: true,
      Thu: false,
      Fri: true,
      Sat: false,
      Sun: true,
    })

    const suggestionSetByArray = await m.Suggestion.create({
      board: geojsonPoint([103.8, 1.38]),
      alight: geojsonPoint([103.9, 1.39]),
      time: makeTime(8, 0),
      daysOfWeek: {
        Mon: false,
        Tue: false,
        Wed: true,
        Thu: true,
        Fri: true,
        Sat: true,
        Sun: false,
      },
    })

    expect(suggestionSetByArray.daysMask).to.equal(parseInt('0111100', 2))

    await expect((async () => m.Suggestion.create({
      board: geojsonPoint([103.8, 1.38]),
      alight: geojsonPoint([103.9, 1.39]),
      time: makeTime(8, 0),
      daysOfWeek: {
        Mon: false,
        Tue: false,
        Wed: true,
        Thu: true,
        Fri: true,
        Sat: true,
        // Sunday missing
      },
    }))()).rejects()
  })
})
