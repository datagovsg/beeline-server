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
    await m.Suggestion.destroy({where: ['1=1'], cascade: true})
  })

  lab.test("Create and fetch suggestions", async () => {
    // Create suggestions
    let suggestionsData = [
      {
        board: {lat: 1.2, lng: 103.1},
        boardDesc: { 
          postalCode: 1013, 
          description: "16, A Street, S 1013", 
          oneMapAddress: { postal: 1013, blk_no: 16, road_name: "A Street" } 
        },
        alightDesc: { 
          postalCode: 1023, 
          description: "18, B Street, S 1023", 
          oneMapAddress: { postal: 1023, blk_no: 18, road_name: "B Street" } 
        },
        alight: {lat: 1.4, lng: 104.0},
        time: makeTime(7, 30),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.21, lng: 103.2},
        boardDesc: { 
          postalCode: 1033, 
          description: "16, C Street, S 1033", 
          oneMapAddress: { postal: 1033, blk_no: 16, road_name: "C Street" } 
        },
        alightDesc: { 
          postalCode: 1113, 
          description: "18, D Street, S 1113", 
          oneMapAddress: { postal: 1113, blk_no: 18, road_name: "D Street" } 
        },
        alight: {lat: 1.39, lng: 103.9},
        time: makeTime(8, 0),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.22, lng: 103.3},
        boardDesc: { 
          postalCode: 1213, 
          description: "16, E Street, S 1213", 
          oneMapAddress: { postal: 1213, blk_no: 16, road_name: "E Street" } 
        },
        alightDesc: { 
          postalCode: 1313, 
          description: "18, F Street, S 1313", 
          oneMapAddress: { postal: 1313, blk_no: 18, road_name: "F Street" } 
        },
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
    expect(singleResult.result.alightDesc.description).equal("18, B Street, S 1023")
    expect(singleResult.result.board.coordinates[0]).equal(103.1)
    expect(singleResult.result.boardDesc.description).equal("16, A Street, S 1013")

    // Fetch personal suggestions
    const userFetchPersonalResponse = await server.inject({
      url: "/suggestions",
      method: "GET",
      headers: userHeaders,
    })
    expect(userFetchPersonalResponse.result.length).equal(3)
    expect(userFetchPersonalResponse.result.every(r => r.userId === user.id))

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
      boardDesc: { 
        postalCode: 1013, 
        description: "16, A Street, S 1013", 
        oneMapAddress: { postal: 1013, blk_no: 16, road_name: "A Street" } 
      },
      alightDesc: { 
        postalCode: 1023, 
        description: "18, B Street, S 1023", 
        oneMapAddress: { postal: 1023, blk_no: 18, road_name: "B Street" } 
      },
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
        boardDesc: { 
          postalCode: 4560, 
          description: "456, A Street, S 4560", 
          oneMapAddress: { postal: 4560, blk_no: 456, road_name: "A Street" } 
        },
        alightDesc: { 
          postalCode: 7560, 
          description: "756, B Street, S 7560", 
          oneMapAddress: { postal: 7560, blk_no: 756, road_name: "B Street" } 
        },
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
    expect(suggestion.boardDesc.description).equal("456, A Street, S 4560")
    expect(suggestion.alight.coordinates[1]).equal(1.3)
    expect(suggestion.alightDesc.description).equal("756, B Street, S 7560")
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
      boardDesc: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapAddress: { postal: 4560, blk_no: 456, road_name: "A Street" } 
      },
      alightDesc: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapAddress: { postal: 7560, blk_no: 756, road_name: "B Street" } 
      },
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
      boardDesc: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapAddress: { postal: 4560, blk_no: 456, road_name: "A Street" } 
      },
      alightDesc: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapAddress: { postal: 7560, blk_no: 756, road_name: "B Street" } 
      },
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
      boardDesc: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapAddress: { postal: 4560, blk_no: 456, road_name: "A Street" } 
      },
      alightDesc: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapAddress: { postal: 7560, blk_no: 756, road_name: "B Street" } 
      },
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
      boardDesc: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapAddress: { postal: 4560, blk_no: 456, road_name: "A Street" } 
      },
      alightDesc: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapAddress: { postal: 7560, blk_no: 756, road_name: "B Street" } 
      },
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
