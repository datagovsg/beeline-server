import Lab from "lab"
import _ from "lodash"
import sinon from "sinon"
import axios from "axios"
import { expect } from "code"
import subzones from "@opengovsg/ura-subzones"
import { loginAs, randomEmail, createStripeToken } from "./test_common.js"
import Joi from '../src/lib/util/joi'

const server = require("../src/index.js")
const {models: m} = require("../src/lib/core/dbschema")()

export const lab = Lab.script()

lab.experiment("Suggested routes manipulation", function () {
  let superadminHeaders
  let userHeaders
  let user
  let suggestion
  let sandbox

  const makeTime = (hour, minutes) => hour * 3600e3 + minutes * 60e3

  lab.before({timeout: 10000}, async function () {
    user = await m.User.create({
      name: "My Test User",
      email: randomEmail(),
      emailVerified: true,
    })
    userHeaders = {
      authorization: `Bearer ${user.makeToken()}`,
    }
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

    sandbox = sinon.sandbox.create()
  })

  lab.after(async function () {
    sandbox.restore()
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
      payload: [{
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

  lab.test("create and convert suggested route to crowdstart", {timeout: 20000}, async () => {
    // create suggested route 
    const routeStops = [{
      lat: 1.31,
      lng: 103.81,
      stopId: 100,
      description: 'Bus Stop 0',
      time: 7 * 3600e3,
    }, {
      lat: 1.32,
      lng: 103.82,
      stopId: 102,
      description: 'Bus Stop 1',
      time: 8 * 3600e3,
    }, {
      lat: 1.33,
      lng: 103.83,
      stopId: 103,
      description: 'Bus Stop 2',
      time: 9 * 3600e3,
    }, {
      lat: 1.34,
      lng: 103.84,
      stopId: 104,
      description: 'Bus Stop 3',
      time: 10 * 3600e3,
    }]

    const postResponse = await server.inject({
      method: 'POST',
      url: `/suggestions/${suggestion.id}/suggested_routes`,
      headers: superadminHeaders,
      payload: routeStops,
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
      headers: userHeaders,
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
      headers: userHeaders,
      payload: {stripeToken},
    })
    expect(addCardResponse.statusCode).equal(200)
    await user.reload()

    // try convert to crowdstart again
    const validResponse = await server.inject(request)
    expect(validResponse.statusCode).equal(200)

    // check a new bid
    const userBids = await m.Bid.findAll({
      where: {userId: user.id},
    })
    expect(userBids.length).equal(1)
    expect(userBids[0].price).equal('5.00')
    expect(validResponse.result.bid.id).equal(userBids[0].id)

    const [route] = await m.Route.findAll({
      where: {id: userBids[0].routeId},
      include: [
        { model: m.Trip, include: [{model: m.TripStop, include: [m.Stop]}]},
      ],
    })

    expect(validResponse.result.route.id).equal(route.id)

    expect(route.tags).include('tentative')
    expect(route.tags).include('crowdstart')
    expect(route.tags).include('autogenerated')
    expect(route.trips.length === 1)
    expect(new Date(route.notes.crowdstartExpiry).getTime()).most(
      Date.now() + 30 * 24 * 3600e3
    )
    expect(route.notes.noPasses).equal(15)
    expect(route.notes.tier[0].pax).equal(15)
    expect(route.notes.tier[0].price).equal(5)
    expect(route.trips[0].date).most(
      Date.now() + 15 * 24 * 3600e3
    )
    expect(route.path).equal([
      [routeStops[0].lat, routeStops[0].lng],
      [routeStops[1].lat, routeStops[1].lng],
      [routeStops[2].lat, routeStops[2].lng],
      [routeStops[3].lat, routeStops[3].lng],
    ])

    const from = 
      subzones
        .getSubzoneAtPoint([routeStops[0].lng, routeStops[0].lat])
        .properties.niceName
    const to = 
      subzones
        .getSubzoneAtPoint(
          [routeStops[routeStops.length - 1].lng, routeStops[routeStops.length - 1].lat]
        ).properties.niceName

    expect(route.name).equal(`${from} to ${to}`)
    expect(route.from).equal(`${from}`)
    expect(route.to).equal(`${to}`)

    const tripStops = _.sortBy(route.trips[0].tripStops, ts => ts.time)

    expect(tripStops.length).equal(routeStops.length)
    expect(tripStops[0].time.getTime()).equal(7 * 3600 * 1000)
    expect(tripStops[tripStops.length - 1].time.getTime()).equal(10 * 3600 * 1000)

    tripStops.slice(0, tripStops.length - 1)
      .forEach(ts => expect(ts.canBoard).true())
    tripStops.slice(1, tripStops.length)
      .forEach(ts => expect(ts.canAlight).true())

    // Check the stop description
    routeStops.forEach(s => {
      expect(tripStops.some(ts => ts.stopId === s.stopId)).true()
    })
  })

  lab.test("trigger new route generation", async () => {
    const routeDetails = {
      maxDetourMinutes: 2.0,
      startClusterRadius: 4000,
      startWalkingDistance: 400,
      endClusterRadius: 4000,
      endWalkingDistance: 400,
      timeAllowance: 1800 * 1000, // Half an hour
      daysOfWeek: 31, // 0b0011111 = Mon-Fri
      dataSource: "suggestions",
    }

    // Intercept calls to routing.beeline.sg
    const axiosPost = sandbox.stub(axios, 'post', async (url) => {
      return {
        data: "Job queued",
        status: 200,
      }
    })

    const postResponse = await server.inject({
      method: 'POST',
      url: `/suggestions/${suggestion.id}/suggested_routes/trigger_route_generation`,
      headers: userHeaders,
      payload: routeDetails,
    })

    expect(axiosPost.called).true()
    expect(postResponse.statusCode).equal(200)
    expect(postResponse.result).equal("Job queued")
  })
})
