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
  let suggestedRoute

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
    await m.SuggestedRoute.destroy({where: ['1=1'], cascade: true})

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

    suggestedRoute = await m.SuggestedRoute.create({
      seedSuggestionId
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

  lab.test("create and convert suggested route to crowdstart", async () => {
    // create suggested route 
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

    // check suggested route has been created
     const getResponse = await server.inject({
      method: 'GET',
      url: `/suggestions/${suggestion.id}/suggested_routes/${postResponse.result.id}`,
    })
    expect(getResponse.statusCode).equal(200)
    expect(getResponse.result.id).equal(postResponse.result.id)

    const suggestedRouteId = postResponse.result.id
    const request = {
      method: 'POST',
      url: `/suggestions/${suggestion.id}/suggested_routes/${suggestedRouteId}/convert_to_crowdstart`,
      headers: superadminHeaders
    }

    // test when user has no payment method 
    const noPaymentMethodResponse = await server.inject(request)
    expect(noPaymentMethodResponse.statusCode).equal(400)
    expect(noPaymentMethodResponse.result.message).includes('at least one saved payment')

    // add payment method
    const stripeToken = await createStripeToken()
    const addCardResponse = await server.inject({
      method: 'POST',
      url: `/users/${user.id}/creditCards`,
      headers: superadminHeaders,
      payload: {stripeToken}
    })
    expect(addCardResponse.statusCode).equal(200)
    await user.reload()

    // try convert to crowdstart again
    const postResponse2 = await server.inject(request)
    expect(postResponse2.statusCode).equal(200)

    // check a new bid
    const userBids = await m.Bid.findAll({
      where: {userId: user.id}
    })
    expect(userBids.length).equal(1)
    expect(userBids[0].price).equal('5.00')

    expect(postResponse2.result.bid.id).equal(userBids[0].id)

    expect(validResponse.result.route.id).equal(route.id)

    expect(route.tags).include('tentative')
    expect(route.tags).include('crowdstart')
    expect(route.tags).include('autogenerated')
    expect(route.trips.length === 1)
    expect(new Date(route.notes.crowdstartExpiry).getTime()).most(
      Date.now() + 15.01 * 24 * 3600e3
    )
    expect(route.notes.noPasses).equal(15)
    expect(route.notes.tier[0].pax).equal(15)
    expect(route.notes.tier[0].price).equal(5)
    expect(route.trips[0].date).most(
      Date.now() + 31.01 * 24 * 3600e3
    )

    expect(route.name).equal(`Bus Stop 3073 to Bus Stop 211`)
    expect(route.from).equal(`Bus Stop 3073`)
    expect(route.to).equal(`Bus Stop 211`)

    const tripStops = _.sortBy(route.trips[0].tripStops, ts => ts.time)

    expect(tripStops.length).equal(stops.length)
    expect(midnightOffset(tripStops[tripStops.length - 1].time)).equal(7.5 * 3600 * 1000)
    expect(midnightOffset(tripStops[0].time)).equal(7.5 * 3600 * 1000 - 1600 - 60000 * 7)

    tripStops.slice(0, 4)
      .forEach(ts => expect(ts.canBoard && !ts.canAlight).true())
    tripStops.slice(4)
      .forEach(ts => expect(!ts.canBoard && ts.canAlight).true())

    // Check the stop description
    stops.forEach(sindex => {
      expect(tripStops.some(ts => ts.stop.description === `Bus Stop ${sindex}`)).true()
    })
    expect(tripStops.length).equal(stops.length)

    // Cursorily check the path
    expect(polyline.decode(route.path)
      .every(([lat, lng]) => (Math.abs(lat) < 90 && Math.abs(lng) < 180))).true()
  })
})
