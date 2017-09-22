const Lab = require("lab")
const {expect} = require("code")
const _ = require('lodash')
const server = require("../src/index.js")

const {resetTripInstances, createStripeToken, loginAs} = require("./test_common")
const {models} = require("../src/lib/core/dbschema")()
const {createUsersCompaniesRoutesAndTrips} = require('./test_data')

const lab = exports.lab = Lab.script()

lab.experiment("Crowdstart", function () {
  let userInstance, user2Instance
  let companyInstance
  let routeInstance
  let stopInstances
  let tripInstances
  let otherCompanyInstance
  let basePrice
  let addCardResponse, addCardResponse2

  const authHeaders = {}

  lab.before({timeout: 20000}, async () => {
    // destroy cached crowdstart route if any
    await models.Bid.destroy({ truncate: true })
    await models.Route.destroy({
      where: {
        tags: {$contains: ['crowdstart']}
      }
    })

    basePrice = 8.00;

    ({userInstance, companyInstance, routeInstance, tripInstances, stopInstances} =
      await createUsersCompaniesRoutesAndTrips(models))

    otherCompanyInstance = models.TransportCompany.create({})

    await Promise.all(tripInstances.slice(1).map(t => t.destroy()))
    tripInstances = [tripInstances[0]]

    const adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['manage-routes', 'view-passengers']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}


    const otherAdminToken = (await loginAs("admin", {
      transportCompanyId: otherCompanyInstance.id,
      permissions: ['manage-routes', 'view-passengers']
    })).result.sessionToken
    authHeaders.otherAdmin = {authorization: "Bearer " + otherAdminToken}

    // Set them to a fixed price
    await Promise.all(
      tripInstances.map(t => t.update({price: basePrice}))
    )
    await routeInstance.update({
      tags: ['crowdstart'],
      notes: {
        noPasses: 10,
      },
    })

    authHeaders.user = {authorization: "Bearer " + userInstance.makeToken()}

    addCardResponse = await server.inject({
      method: 'POST',
      url: `/users/${userInstance.id}/creditCards`,
      headers: authHeaders.user,
      payload: {
        stripeToken: await createStripeToken()
      }
    })
    expect(addCardResponse.statusCode).equal(200)

    // Need a second user
    user2Instance = await models.User.create({name: 'lollol'})
    addCardResponse2 = await server.inject({
      method: 'POST',
      url: `/users/${user2Instance.id}/creditCards`,
      headers: {authorization: `Bearer ${user2Instance.makeToken()}`},
      payload: {
        stripeToken: await createStripeToken()
      }
    })
    console.log(addCardResponse2.result)
    expect(addCardResponse2.statusCode).equal(200)
    authHeaders.user2 = {authorization: `Bearer ${user2Instance.makeToken()}`}
  })

  lab.after({timeout: 10000}, async () => {
    try {
      await models.TripStop.destroy({
        where: {
          stopId: {$in: stopInstances.map(i => i.id)},
          tripId: {$in: tripInstances.map(i => i.id)},
        }
      })
      await Promise.all(tripInstances.map(instance => instance.destroy()))
      await routeInstance.destroy()
      await companyInstance.destroy()
      await userInstance.destroy()
    } catch (err) {
      console.error(err.stack)
    }
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get "user already has ticket" errors, or unexpected
    capacity errors
  */
  lab.afterEach(async () => {
    await models.Bid.destroy({ truncate: true })
    await resetTripInstances(models, tripInstances)
  })

  lab.test("crowdstart route is not run by company X", {timeout: 10000}, async function () {
    let companyId = companyInstance.id + 1
    const crowdstartRouteResponse = await server.inject({
      method: 'GET',
      url: '/crowdstart/status?transportCompanyId=' + companyId,
    })
    expect(crowdstartRouteResponse.statusCode).equal(200)
    expect(crowdstartRouteResponse.result.length).equal(0)
  })

  lab.test("crowdstart route is run by company X", {timeout: 10000}, async function () {
    let companyId = companyInstance.id
    const crowdstartRouteResponse = await server.inject({
      method: 'GET',
      url: '/crowdstart/status?transportCompanyId=' + companyId
    })
    expect(crowdstartRouteResponse.statusCode).equal(200)
    expect(crowdstartRouteResponse.result.length).equal(1)
    expect(crowdstartRouteResponse.result[0].transportCompanyId = companyId)
  })

  lab.test("crowdstart routes run by all companies", {timeout: 10000}, async function () {
    const crowdstartRouteResponse = await server.inject({
      method: 'GET',
      url: '/crowdstart/status',
    })
    expect(crowdstartRouteResponse.statusCode).equal(200)
    expect(crowdstartRouteResponse.result.length).equal(1)
  })

  lab.test("CRUD /crowdstart/routes/{routeId}/bids", {timeout: 20000}, async function () {
    async function bidWithHeaders (headers, statusCode = 200) {
      const saleResponse = await server.inject({
        method: 'POST',
        url: `/crowdstart/routes/${routeInstance.id}/bids`,
        payload: {
          price: 7,
        },
        headers
      })
      expect(saleResponse.statusCode).equal(statusCode)
      return saleResponse
    }

    // Make the purchase...
    const saleResponse1 = await bidWithHeaders(authHeaders.user)

    // Check the bidding result
    const checkResponse = await server.inject({
      method: 'GET',
      url: '/crowdstart/status',
      headers: authHeaders.user
    })
    expect(checkResponse.statusCode).equal(200)
    expect(checkResponse.result.find(route => route.id === routeInstance.id).bids.length).equal(1)

    // Second ticket not allowed
    const saleResponse2 = await bidWithHeaders(authHeaders.user, 400)
    expect(saleResponse2.statusCode).not.equal(200)

    // Make bid by second user
    const bidFromUser2 = (await bidWithHeaders(authHeaders.user2)).result

    // Cannot delete card info now!
    const deleteCardResponse = await server.inject({
      method: 'DELETE',
      url: `/users/${user2Instance.id}/creditCards/${addCardResponse2.result.sources.data[0].id}`,
      headers: authHeaders.user2
    })
    expect(deleteCardResponse.statusCode).equal(400)

    // Check the bidding result
    const checkResponse2 = await server.inject({
      method: 'GET',
      url: '/crowdstart/status',
      headers: authHeaders.admin
    })
    expect(checkResponse2.statusCode).equal(200)
    expect(checkResponse2.result.find(route => route.id === routeInstance.id).bids.length).equal(2)

    // Test GET /bids bid price is $7 befor 'update_price'
    const getResponse = await server.inject({
      method: 'GET',
      url: `/crowdstart/bids`,
      headers: authHeaders.user2
    })
    expect(getResponse.statusCode).equal(200)
    expect(getResponse.result.length).equal(1)
    expect(getResponse.result[0].priceF).equal(7)


    // Update the existing bid price
    const updateResponse = await server.inject({
      method: 'POST',
      url: `/crowdstart/routes/${routeInstance.id}/bids/update_price`,
      payload: {
        price: 6,
      },
      headers: authHeaders.admin
    })
    expect(updateResponse.statusCode).equal(200)

    const allBids = await server.inject({
      method: 'GET',
      url: `/crowdstart/routes/${routeInstance.id}/bids`,
      headers: authHeaders.admin
    })
    expect(allBids.statusCode).equal(200)
    expect(allBids.result.length).equal(2)

    // Test GET /bids
    const getResponse1 = await server.inject({
      method: 'GET',
      url: `/crowdstart/bids`,
      headers: authHeaders.user2
    })
    expect(getResponse1.statusCode).equal(200)
    expect(getResponse1.result.length).equal(1)
    // price is updated to 6 from eariler 'update_price'
    expect(getResponse1.result[0].priceF).equal(6)

    // Test GET /users/{userId}/bids
    // It should contain user2's bids for admin
    // It should be blank for admin2
    const queryByUserResponse1 = await server.inject({
      method: 'GET',
      url: `/crowdstart/users/${user2Instance.id}/bids`,
      headers: authHeaders.admin
    })
    expect(queryByUserResponse1.statusCode).equal(200)
    expect(queryByUserResponse1.result.find(b => b.userId === user2Instance.id))
      .exist()

    const queryByUserResponse2 = await server.inject({
      method: 'GET',
      url: `/crowdstart/users/${user2Instance.id}/bids`,
      headers: authHeaders.otherAdmin
    })
    expect(queryByUserResponse2.statusCode).equal(200)
    expect(queryByUserResponse2.result.length).equal(0)

    // Test DELETE
    const deleteResponse1 = await server.inject({
      method: 'DELETE',
      url: `/crowdstart/routes/${routeInstance.id}/bids`,
      headers: authHeaders.user2
    })
    expect(deleteResponse1.statusCode).equal(200)

    // After deleting, the card can be deleted
    const deleteCardResponse2 = await server.inject({
      method: 'DELETE',
      url: `/users/${user2Instance.id}/creditCards/${addCardResponse2.result.sources.data[0].id}`,
      headers: authHeaders.user2
    })
    expect(deleteCardResponse2.statusCode).equal(200)

    // Test GET /bids
    const getResponse2 = await server.inject({
      method: 'GET',
      url: `/crowdstart/bids`,
      headers: authHeaders.user2
    })
    expect(getResponse2.statusCode).equal(200)
    expect(getResponse2.result.length).equal(0)

    // Check the bidding result
    const checkResponse3 = await server.inject({
      method: 'GET',
      url: '/crowdstart/status',
      headers: authHeaders.admin
    })
    expect(checkResponse3.statusCode).equal(200)
    expect(checkResponse3.result.find(route => route.id === routeInstance.id).bids.length).equal(1)

    // Admin can delete users
    const deleteCardResponse3 = await server.inject({
      method: 'DELETE',
      url: `/crowdstart/routes/${routeInstance.id}/bids/${saleResponse1.result.id}`,
      headers: authHeaders.admin
    })
    expect(deleteCardResponse3.statusCode).equal(200)

    // Check again -- there should be no routes left
    // Check the bidding result
    const checkResponse4 = await server.inject({
      method: 'GET',
      url: '/crowdstart/status',
      headers: authHeaders.admin
    })
    expect(checkResponse4.statusCode).equal(200)
    expect(checkResponse4.result.find(route => route.id === routeInstance.id).bids.length).equal(0)

    // Make another bid...
    const bid = (await bidWithHeaders(authHeaders.user)).result

    const label = 'G0'

    const activateResponse = await server.inject({
      method: 'POST',
      url: `/crowdstart/routes/${routeInstance.id}/activate`,
      headers: authHeaders.admin,
      payload: {
        price: 7,
        label
      },
    })
    expect(activateResponse.statusCode).equal(200)
    expect(activateResponse.result.tags).include(`crowdstart-${activateResponse.result.id}`)
    expect(activateResponse.result.label).equal(label)

    const convertBidResponse = await server.inject({
      method: 'POST',
      url: `/crowdstart/routes/${routeInstance.id}/bids/${bid.id}/convert`,
      headers: authHeaders.admin,
    })
    expect(convertBidResponse.statusCode).equal(200)

    const bidInst = await models.Bid.findById(bid.id)
    expect(bidInst.status).equal('void')

    const routePasses = await models.RoutePass.findAll({
      where: {
        userId: userInstance.id,
        tag: `crowdstart-${activateResponse.result.id}`,
      }
    })
    expect(routePasses.length).equal(+routeInstance.notes.noPasses)

    await Promise.all(routePasses.map(p => p.destroy()))

    // Reinstate the second user's bid, but with a bad credit card
    // His bid should then record the charge failure
    const bidFromUser2Inst = await models.Bid.findById(bidFromUser2.id)
    await bidFromUser2Inst.update({status: 'bidded'})
    await server.inject({
      method: 'POST',
      url: `/users/${user2Instance.id}/creditCards`,
      headers: {authorization: `Bearer ${user2Instance.makeToken()}`},
      payload: {
        stripeToken: await createStripeToken("4000000000000341")
      }
    })
    const convertBidFromUser2Response = await server.inject({
      method: 'POST',
      url: `/crowdstart/routes/${routeInstance.id}/bids/${bidFromUser2.id}/convert`,
      headers: authHeaders.admin,
    })
    expect(convertBidFromUser2Response.statusCode).equal(402)
    await bidFromUser2Inst.reload()
    console.log(bidFromUser2Inst.notes)
    expect(Object.entries(bidFromUser2Inst.notes).length).equal(1)
    expect(bidFromUser2Inst.status).equal('bidded')

    const routePasses2 = await models.RoutePass.findAll({
      where: {
        userId: user2Instance.id,
        tag: `crowdstart-${activateResponse.result.id}`,
        status: 'failed'
      }
    })
    expect(+routePasses2.length).equal(9)

    const newRoute = await models.Route.findById(activateResponse.result.id, {include: [{ model: models.Trip, include: [models.TripStop]}]})
    const tripAttributesOf = trip => _.omit(trip.toJSON(), 'id', 'createdAt', 'updatedAt', 'tripStops', 'routeId', 'price')
    expect(tripAttributesOf(newRoute.trips[0])).equal(_.assign(tripAttributesOf(tripInstances[0]), {priceF: 7}))
    await newRoute.destroy()
    await routeInstance.update({ tags: routeInstance.tags.splice(routeInstance.tags.indexOf('success'), 1)})

    // Revert bid back to bidded status...
    await bidInst.update({ status: 'bidded' })

    const expireResponse = await server.inject({
      method: 'POST',
      url: `/crowdstart/routes/${routeInstance.id}/expire`,
      headers: authHeaders.admin,
    })
    expect(expireResponse.statusCode).equal(200)

    await routeInstance.reload()
    expect(routeInstance.tags).include(`failed`)
    await bidInst.reload()
    expect(bidInst.status).equal('failed')
  })
})
