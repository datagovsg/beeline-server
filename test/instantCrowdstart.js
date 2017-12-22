var Lab = require("lab")
export var lab = Lab.script()
var {expect} = require("code")
var server = require("../src/index.js")

const {models: m} = require("../src/lib/core/dbschema")()
const _ = require("lodash") // from 'lodash'
const {createStripeToken, randomEmail} = require("./test_common")
const sinon = require('sinon')
import axios from 'axios'
import querystring from 'querystring'

lab.experiment("Instant Crowdstarts", function () {
  let sandbox

  lab.beforeEach({timeout: 10000}, async (done) => {
    sandbox = sinon.sandbox.create()
  })

  lab.afterEach(async () => {
    sandbox.restore()
  })

  function stubRoutingServer (stops) {
    sandbox.stub(axios, 'get', async (url) => {
      const stopsJoinedWithSlash = stops.join('/')
      const travelTimesURL = `https://routing.beeline.sg/travel_times/${stopsJoinedWithSlash}`
      const busStopsURL = `https://routing.beeline.sg/bus_stops/${stopsJoinedWithSlash}`
      const pathsURL = `https://routing.beeline.sg/path_requests/${stopsJoinedWithSlash}?maxDistance=400`

      const fakeBusStops = stops
        .map(i => ({
          index: parseInt(i),
          coordinates: [parseFloat(`103.8${i}`), parseFloat(`1.3${i}`)],
          description: `Bus Stop ${i}`
        }))
      const fakeRequests = _.range(0, 20).map(i => {
        const randomStopA = fakeBusStops[Math.floor(Math.random() * fakeBusStops.length)]
        const randomStopB = fakeBusStops[Math.floor(Math.random() * fakeBusStops.length)]

        const genRandomLatLng = (stop) => ({
          lng: stop.coordinates[0] + (Math.random() * 0.001 - 0.0005),
          lat: stop.coordinates[1] + (Math.random() * 0.001 - 0.0005),
        })

        return {
          start: genRandomLatLng(randomStopA),
          end: genRandomLatLng(randomStopB),
        }
      })

      if (url === travelTimesURL) {
        return {
          data: [100, 200, 300, 400, 300, 200, 100],
          statusCode: 200
        }
      } else if (url === busStopsURL) {
        return {
          data: fakeBusStops,
          statusCode: 200
        }
      } else if (url === pathsURL) {
        return {
          data: fakeRequests,
          statusCode: 200,
        }
      } else {
        throw new Error(`Unexpected URL ${url}`)
      }
    })
  }

  lab.test("User can create crowdstart from autogenerated route", {timeout: 30000}, async function () {
    // Pick a bunch of stops starting in the heartlands,
    // ending in the city, to ensure we exceed the threshold
    const stops = [3073, 3071, 3065, 3051, 129, 116, 106, 211]
    const user = await m.User.create({telephone: randomEmail()})
    const ARRIVAL_TIME = 7.5 * 3600 * 1000

    const defaultInjectOptions = {
      method: 'POST',
      url: `/crowdstart/instant`,
      payload: {
        stops: stops,
        arrivalTime: ARRIVAL_TIME,
      },
      headers: {
        authorization: `Bearer ${user.makeToken()}`
      }
    }

    const unauthenticatedResponse = await server.inject({
      ...defaultInjectOptions,
      headers: {}
    })
    expect(unauthenticatedResponse.statusCode).equal(403)

    const noPaymentMethodResponse = await server.inject(defaultInjectOptions)
    expect(noPaymentMethodResponse.statusCode).equal(400)
    expect(noPaymentMethodResponse.result.message).includes('at least one saved payment')

    // Add some payment method
    const stripeToken = await createStripeToken()
    const addCardResponse = await server.inject({
      method: 'POST',
      url: `/users/${user.id}/creditCards`,
      headers: defaultInjectOptions.headers,
      payload: {stripeToken}
    })
    expect(addCardResponse.statusCode).equal(200)

    await user.reload()

    // Try bidding again...
    // But first, intercept the calls to routing.beeline.sg
    stubRoutingServer(stops)
    const validResponse = await server.inject(defaultInjectOptions)
    expect(validResponse.statusCode).equal(200)

    // Now there should be a new bid
    const userBids = await m.Bid.findAll({
      where: {userId: user.id}
    })
    expect(userBids.length).equal(1)
    expect(userBids[0].price).equal('5.00')

    expect(validResponse.result.bid.id).equal(userBids[0].id)

    const [route] = await m.Route.findAll({
      where: {id: userBids[0].routeId},
      include: [
        { model: m.Trip, include: [{model: m.TripStop, include: [m.Stop]}]}
      ]
    })

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
  })

  lab.test("Anyone can preview crowdstart route", {timeout: 30000}, async function () {
    // Pick a bunch of stops starting in the heartlands,
    // ending in the city, to ensure we exceed the threshold
    const stops = [3073, 3071, 3065, 3051, 129, 116, 106, 211]

    stubRoutingServer(stops)

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/crowdstart/preview_instant?` + querystring.stringify({
        stops: JSON.stringify(stops),
        arrivalTime: 7.5 * 3600 * 1000,
      }),
    })
    expect(previewResponse.statusCode).equal(200)

    const route = previewResponse.result
    const tripStops = _.sortBy(route.trips[0].tripStops, ts => ts.time)

    expect(midnightOffset(tripStops[tripStops.length - 1].time)).equal(7.5 * 3600 * 1000)
    expect(midnightOffset(tripStops[0].time)).equal(7.5 * 3600 * 1000 - 1600 - 60000 * 7)

    // Check the stop description
    stops.forEach(sindex => {
      expect(tripStops.some(ts => ts.stop.description === `Bus Stop ${sindex}`)).true()
    })
    expect(tripStops.length).equal(stops.length)
  })
})

// Check the route time
function midnightOffset (date) {
  const midnight = new Date(date.getTime())
  midnight.setHours(0, 0, 0, 0)

  return date.getTime() - midnight.getTime()
}