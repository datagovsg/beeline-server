const {models: m} = require('../src/lib/core/dbschema')()
const {resetTripInstances, loginAs, createStripeToken} = require("./test_common")
import {createUsersCompaniesRoutesAndTrips} from './test_data'
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import _ from 'lodash'
import querystring from 'querystring'

export var lab = Lab.script()

lab.experiment("TransactionItems", function () {
  var userInstance, companyInstance, routeInstance, trips
  var authHeaders = {}
  const ticketPrice = '5.00'
  const ticketsBought = 5
  var testTag

  lab.before({timeout: 30000}, async function () {
    ({userInstance, companyInstance, routeInstance, tripInstances: trips} =
      await createUsersCompaniesRoutesAndTrips(m, new Array(ticketsBought).fill(+ticketPrice)))

    testTag = `rp-${Date.now()}`

    await routeInstance.update({
      tags: [testTag]
    })

    var userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    var adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund', 'manage-routes', 'issue-tickets', 'view-transactions']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    var superToken = (await loginAs('superadmin')).result.sessionToken
    authHeaders.super = { authorization: 'Bearer ' + superToken }

    // Set up pre-made transactions:
    // buy 1 ticket, paid using routeCredits
    // buy 2 tickets, 1 paid using routeCredits
    // buy 2 tickets, paid with money. Refund 1 to credits.
    // issue free credits
    // purchase credits with money
    // 1 failed transaction

    const userId = userInstance.id
    const companyId = companyInstance.id

    // Create the user credits
    await m.RoutePass.destroy({
      where: {userId, tag: testTag}
    })

    await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 2 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        quantity: 2,
        tag: testTag
      },
      headers: authHeaders.admin,
    })

    const purchaseItems1 = [{
      tripId: trips[0].id,
      boardStopId: trips[0].tripStops[0].id,
      alightStopId: trips[0].tripStops[4].id,
    }]

    const purchaseItems2 = [{
      tripId: trips[1].id,
      boardStopId: trips[1].tripStops[0].id,
      alightStopId: trips[1].tripStops[4].id,
    }, {
      tripId: trips[2].id,
      boardStopId: trips[2].tripStops[0].id,
      alightStopId: trips[2].tripStops[4].id,
    }]

    const purchaseItems3 = [{
      tripId: trips[3].id,
      boardStopId: trips[3].tripStops[0].id,
      alightStopId: trips[3].tripStops[4].id,
    }, {
      tripId: trips[4].id,
      boardStopId: trips[4].tripStops[0].id,
      alightStopId: trips[4].tripStops[4].id,
    }]

    const saleResponse1 = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems1,
        applyRoutePass: true,
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user
    })
    expect(saleResponse1.statusCode).to.equal(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const failedSaleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems2,
        creditTag: testTag,
        stripeToken: 'Fake stripe token',
      },
      headers: authHeaders.user
    })
    expect(failedSaleResponse.statusCode).to.equal(402)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const saleResponse2 = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems2,
        applyRoutePass: true,
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user
    })
    expect(saleResponse2.statusCode).to.equal(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const saleResponse3 = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems3,
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user
    })
    expect(saleResponse3.statusCode).to.equal(200)

    const saleTIByType = _.groupBy(saleResponse3.result.transactionItems,
      ti => ti.itemType)
    expect(saleTIByType.ticketSale).exist()
    expect(saleTIByType.ticketSale.length).equal(2)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${saleTIByType.ticketSale[0].itemId}/refund/route_pass`,
      payload: {
        targetAmt: ticketPrice,
        creditTag: testTag
      },
      headers: authHeaders.super
    })
    expect(refundResponse.statusCode).to.equal(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    var compensationResponse = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId,
        routeId: routeInstance.id,
        tag: testTag
      },
      headers: authHeaders.admin
    })
    expect(compensationResponse.statusCode).to.equal(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const purchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        value: '5.00',
        creditTag: testTag,
        stripeToken: await createStripeToken(),
        companyId
      },
      headers: authHeaders.user
    })
    expect(purchaseResponse.statusCode).equal(200)

    // end setup
  })

  lab.after(async () => resetTripInstances(m, trips))

  lab.test('Transaction items for route pass transactions', {timeout: 60000}, async function () {
    const companyId = companyInstance.id

    // Expect:
    // 7 transactions, of which 5 are returned

    const txnResponse = await server.inject({
      method: 'GET',
      url: `/companies/${companyId}/transaction_items/route_passes`,
      headers: authHeaders.admin
    })
    expect(txnResponse.statusCode).equal(200)

    console.log(JSON.stringify(txnResponse.result.map(r => r.toJSON()), null, 2))

    expect(txnResponse.result.length).equal(8)

    const transactions = txnResponse.result.map(ti => ti.transaction)
    const txnByType = _.groupBy(transactions, t => t.type)

    expect(_.keys(txnByType).length).equal(4)
    expect(txnByType.ticketPurchase).exist()
    expect(txnByType.ticketPurchase.length).equal(3)
    expect(txnByType.ticketPurchase.filter(t => !t.committed).length).equal(1)
    expect(txnByType.refundToRoutePass).exist()
    expect(txnByType.refundToRoutePass.length).equal(1)
    expect(txnByType.freeRoutePass).exist()
    expect(txnByType.freeRoutePass.length).equal(3)
    expect(txnByType.routePassPurchase).exist()
    expect(txnByType.routePassPurchase.length).equal(1)

    const userResponse = await server.inject({
      method: 'GET',
      url: `/companies/${companyId}/transaction_items/route_passes`,
      headers: authHeaders.user
    })
    expect(userResponse.statusCode).equal(403)

    const noHeaderResponse = await server.inject({
      method: 'GET',
      url: `/companies/${companyId}/transaction_items/route_passes`,
    })
    expect(noHeaderResponse.statusCode).equal(403)
  })

  lab.test('Summary for routeCredits transactions', {timeout: 20000}, async function () {
    const companyId = companyInstance.id

    async function getSummary (queryOptions = {}) {
      const queryString = querystring.stringify(queryOptions)

      const txnResponse = await server.inject({
        method: 'GET',
        url: `/companies/${companyId}/transaction_items/route_passes/summary?` + queryString,
        headers: authHeaders.admin
      })

      expect(txnResponse.statusCode).equal(200)
      expect(txnResponse.result.totalItems).exist()
      expect(txnResponse.result.txnCountByDay).exist()

      return txnResponse.result
    }

    const resp1 = await getSummary()
    expect(resp1.totalItems).equal(8)

    const resp2 = await getSummary({hideUncommittedTransactions: true})
    expect(resp2.totalItems).equal(7)

    const resp3 = await getSummary({transactionType: 'ticketPurchase'})
    expect(resp3.totalItems).equal(3)

    const userResponse = await server.inject({
      method: 'GET',
      url: `/companies/${companyId}/transaction_items/route_passes/summary`,
      headers: authHeaders.user
    })
    expect(userResponse.statusCode).equal(403)

    const noHeaderResponse = await server.inject({
      method: 'GET',
      url: `/companies/${companyId}/transaction_items/route_credits/summary`,
    })
    expect(noHeaderResponse.statusCode).equal(403)
  })
})
