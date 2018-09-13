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
        boardDescription: { 
          postalCode: 1013, 
          description: "16, A Street, S 1013", 
          oneMapData: { POSTAL: 1013, BLK_NO: 16, ROAD_NAME: "A Street" }, 
        },
        alightDescription: { 
          postalCode: 1023, 
          description: "18, B Street, S 1023", 
          oneMapData: { POSTAL: 1023, BLK_NO: 18, ROAD_NAME: "B Street" }, 
        },
        alight: {lat: 1.4, lng: 104.0},
        time: makeTime(7, 30),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.21, lng: 103.2},
        boardDescription: { 
          postalCode: 1033, 
          description: "16, C Street, S 1033", 
          oneMapData: { POSTAL: 1033, BLK_NO: 16, ROAD_NAME: "C Street" }, 
        },
        alightDescription: { 
          postalCode: 1113, 
          description: "18, D Street, S 1113", 
          oneMapData: { POSTAL: 1113, BLK_NO: 18, ROAD_NAME: "D Street" }, 
        },
        alight: {lat: 1.39, lng: 103.9},
        time: makeTime(8, 0),
        daysOfWeek: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: false, Sun: false},
      },
      {
        board: {lat: 1.22, lng: 103.3},
        boardDescription: { 
          postalCode: 1213, 
          description: "16, E Street, S 1213", 
          oneMapData: { POSTAL: 1213, BLK_NO: 16, ROAD_NAME: "E Street" }, 
        },
        alightDescription: { 
          postalCode: 1313, 
          description: "18, F Street, S 1313", 
          oneMapData: { POSTAL: 1313, BLK_NO: 18, ROAD_NAME: "F Street" }, 
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
    expect(singleResult.result.alightDescription.description).equal("18, B Street, S 1023")
    expect(singleResult.result.board.coordinates[0]).equal(103.1)
    expect(singleResult.result.boardDescription.description).equal("16, A Street, S 1013")

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
      boardDescription: { 
        postalCode: 1013, 
        description: "16, A Street, S 1013", 
        oneMapData: { POSTAL: 1013, BLK_NO: 16, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 1023, 
        description: "18, B Street, S 1023", 
        oneMapData: { POSTAL: 1023, BLK_NO: 18, ROAD_NAME: "B Street" }, 
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
        boardDescription: { 
          postalCode: 4560, 
          description: "456, A Street, S 4560", 
          oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
        },
        alightDescription: { 
          postalCode: 7560, 
          description: "756, B Street, S 7560", 
          oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
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
    expect(suggestion.boardDescription.description).equal("456, A Street, S 4560")
    expect(suggestion.alight.coordinates[1]).equal(1.3)
    expect(suggestion.alightDescription.description).equal("756, B Street, S 7560")
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
      boardDescription: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
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
      boardDescription: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
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
      boardDescription: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
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
      boardDescription: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
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

  lab.test("Board and alight descriptions", async function () {
    const completeDescriptions = await m.Suggestion.create({
      board: Joi.attempt({lat: 1.3, lng: 103.8}, Joi.latlng()),
      alight: Joi.attempt({lat: 1.35, lng: 103.75}, Joi.latlng()),
      boardDescription: { 
        postalCode: 4560, 
        description: "456, A Street, S 4560", 
        oneMapData: { POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" }, 
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
      },
      time: makeTime(8, 0),
      daysMask: parseInt('1010111', 2),
    })

    expect(completeDescriptions.boardDescription.postalCode).to.equal(4560)
    expect(completeDescriptions.boardDescription.description).to.equal("456, A Street, S 4560")
    expect(completeDescriptions.boardDescription.oneMapData).to.equal({ POSTAL: 4560, BLK_NO: 456, ROAD_NAME: "A Street" } )

    await expect((async () => m.Suggestion.create({
      board: {lat: 1.2, lng: 103.1},
      alight: {lat: 1.4, lng: 104.0},
      time: makeTime(8, 0),
      boardDescription: { 
        postalCode: 4560,
        description: "456, A Street, S 4560", 
        // oneMapData missibg
      },
      alightDescription: { 
        postalCode: 7560, 
        description: "756, B Street, S 7560", 
        oneMapData: { POSTAL: 7560, BLK_NO: 756, ROAD_NAME: "B Street" }, 
      },
      daysOfWeek: {
        Mon: false,
        Tue: false,
        Wed: true,
        Thu: true,
        Fri: true,
        Sat: true,
        Sun: false,
      },
    }))()).rejects()
  })
})
