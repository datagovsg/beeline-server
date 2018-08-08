import Lab from "lab"
import {expect} from "code"
import { loginAs, randomEmail } from "./test_common.js"
import Joi from '../src/lib/util/joi'

const server = require("../src/index.js")
const {models: m} = require("../src/lib/core/dbschema")()

export const lab = Lab.script()

lab.experiment("Suggested routes manipulation", function () {
  let superadminHeaders
  let user
  let suggestion

  const makeTime = (hour, minutes) => hour * 3600e3 + minutes * 60e3

  lab.before({timeout: 10000}, async function () {
    user = await m.User.create({
      name: "My Test User",
      email: randomEmail(),
      emailVerified: true,
    })
    superadminHeaders = {
      authorization: `Bearer ` + (await loginAs("superadmin", {email: 'beeline-routing@data.gov.sg'}))
        .result.sessionToken,
    }

    // Empty the table
    await m.Suggestion.destroy({where: ['1=1'], cascade: true})

    suggestion = await m.Suggestion.create({
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
  })

  // Note:
  // suggested routes are visible to everybody
  // but can only be modified by superadmin
  lab.test("List, create, fetch and delete suggested routes", async () => {
    const listResponse1 = await server.inject({
      method: 'GET',
      url: `/suggestions/${suggestion.id}/suggested_routes`,
    })
    expect(listResponse1.statusCode).equal(200)
    expect(listResponse1.result.length).equal(0)

    // POST
    const postResponse = await server.inject({
      method: 'POST',
      url: `/suggestions/${suggestion.id}/suggested_routes`,
      headers: superadminHeaders,
      payload: {
        route: [{
          lat: 1.31,
          lng: 103.81,
          stopId: 100,
          description: 'Bla',
          time: 7 * 3600e3,
        }, {
          lat: 1.38,
          lng: 103.88,
          stopId: 101,
          description: 'Bla',
          time: 8 * 3600e3,
        }],
      },
    })
    expect(postResponse.statusCode).equal(200)

    // list again
    const listResponse2 = await server.inject({
      method: 'GET',
      url: `/suggestions/${suggestion.id}/suggested_routes`,
    })
    expect(listResponse2.statusCode).equal(200)
    expect(listResponse2.result.length).equal(1)
    expect(listResponse2.result[0].id).equal(postResponse.result.id)

    const getResponse = await server.inject({
      method: 'GET',
      url: `/suggestions/${suggestion.id}/suggested_routes/${listResponse2.result[0].id}`,
    })
    expect(getResponse.statusCode).equal(200)
    expect(getResponse.result.id).equal(listResponse2.result[0].id)

    // DELETE
    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/suggestions/${suggestion.id}/suggested_routes/${listResponse2.result[0].id}`,
      headers: superadminHeaders,
    })
    expect(deleteResponse.statusCode).equal(200)

    // List last time
    const listResponse3 = await server.inject({
      method: 'GET',
      url: `/suggestions/${suggestion.id}/suggested_routes`,
    })
    expect(listResponse3.statusCode).equal(200)
    expect(listResponse3.result.length).equal(0)
  })
})
