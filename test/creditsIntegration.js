import server from "../src/index"
const {models: m} = require('../src/lib/core/dbschema')()
const {
  resetTripInstances, loginAs, randomString,
  createStripeToken, cleanlyDeletePromotions
} = require("./test_common")
import {expect} from "code"
import Lab from "lab"
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips} from './test_data'

export var lab = Lab.script()

lab.experiment("Credits integration test", function () {
  var templates, userInstance, companyInstance, routeInstance
  var authHeaders = {}
  var testTag
  const ticketPrice = '5.00'
  const ticketsBought = 4
  var itemInsts = []
  var trips

  lab.before({timeout: 15000}, async function () {
    testTag = `rp-${Date.now()}`;

    ({userInstance, companyInstance, routeInstance, tripInstances: trips} =
        await createUsersCompaniesRoutesAndTrips(m, new Array(ticketsBought).fill(+ticketPrice)))

    await routeInstance.update({
      tags: [testTag]
    })

    itemInsts = []
    trips.forEach((trip, i) => {
      itemInsts.push({
        item: {
          tripId: trip.id,
          boardStopId: trip.tripStops[0].id,
          alightStopId: trip.tripStops[2].id,
          // userId: userInstance.id
        },
        ticket: {id: i},
        price: trip.price,
        trip
      })
    })

    var userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    var adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund', 'issue-tickets']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    templates = {
      promoParams: {
        qualifyingCriteria: [
          {type: 'noLimit', params: {}},
        ],
        discountFunction: {
          type: "simpleRate",
          params: {"rate": 0.5}
        },
        refundFunction: {
          type: "refundDiscountedAmt"
        },
        usageLimit: {
          globalLimit: 20,
          userLimit: 10
        }
      }
    }
  })

  lab.afterEach(async () => resetTripInstances(m, trips))

  lab.test("Using route pass, referralCredits, userCredits together", {timeout: 20000}, async () => {
    var userId = userInstance.id
    const usrCreditAmt = '5.00'
    const refCreditAmt = '5.00'

    await m.Credit.destroy({ where: { userId }})
    await m.Credit.create({ userId, balance: usrCreditAmt})
    await m.ReferralCredit.destroy({ where: { userId }})
    await m.ReferralCredit.create({ userId, balance: refCreditAmt})
    await m.RoutePass.destroy({ where: { userId }})
    const routePassIssueFreeResponse = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: testTag
      },
      headers: authHeaders.admin,
    })

    const routePassTransactionItem = routePassIssueFreeResponse.result.transactionItems[0]
    const poItems = itemInsts.map(it => it.item)

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        applyCredits: true,
        applyReferralCredits: true,
        applyRoutePass: true,
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(200)

    let transactionItems = saleResponse.result.transactionItems
    expect(transactionItems.length).equal(12)

    let transactionItemsByType = _.groupBy(transactionItems, ti => ti.itemType)

    var accountInst = await m.Account.find({
      where: {
        name: 'Cost of Goods Sold'
      }
    })

    // tickets bought -> total cost = 4 * $5 = 20
    expect(transactionItemsByType.ticketSale).exist()
    expect(transactionItemsByType.ticketSale.length).equal(ticketsBought)
    expect(_.sum(transactionItemsByType.ticketSale.map(ticket => +ticket.credit)))
      .about(20, 0.0001)

    // Route Credits get first cut -> Remaining: 15
    expect(transactionItemsByType.routePass).exist()
    expect(transactionItemsByType.routePass.length).equal(1)
    expect(transactionItemsByType.routePass[0].itemId).equal(routePassTransactionItem.itemId)
    expect(+transactionItemsByType.routePass[0].debit).about(5, 0.0001)

    // Referral Credits use all: Math.min(remainingCost / 2, balance) = balance
    // Remaining = 15 - 5 = 10
    expect(transactionItemsByType.referralCredits).exist()
    expect(transactionItemsByType.referralCredits.length).equal(1)
    expect(transactionItemsByType.referralCredits[0].itemId).equal(userInstance.id)
    expect(+transactionItemsByType.referralCredits[0].debit).about(5, 0.0001)

    // User Credits use all: balance < remaining
    // Remaining = 10 - 5 = 5
    expect(transactionItemsByType.userCredit).exist()
    expect(transactionItemsByType.userCredit.length).equal(1)
    expect(transactionItemsByType.userCredit[0].itemId).equal(userInstance.id)
    expect(+transactionItemsByType.userCredit[0].debit).about(5, 0.0001)

    // User pays remaining = 5
    expect(transactionItemsByType.payment).exist()
    expect(transactionItemsByType.payment.length).equal(1)
    expect(+transactionItemsByType.payment[0].debit).about(5, 0.0001)

    // COGS = referralCredits + userCredits + payment = 5 + 5 + 5 = 15
    expect(transactionItemsByType.account).exist()
    expect(transactionItemsByType.account.length).equal(1)
    expect(transactionItemsByType.account[0].itemId).equal(accountInst.id)
    expect(+transactionItemsByType.account[0].debit).about(15, 0.0001)

    // 2 'payables' entries, 1 for userCredits, 1 for referralCredits
    expect(transactionItemsByType.payables).exist()
    expect(transactionItemsByType.payables.length).equal(2)
    expect(_.uniq(transactionItemsByType.payables.map(entry => entry.itemId)).length)
      .equal(1)
    expect(transactionItemsByType.payables[0].itemId).equal(companyInstance.id)
    expect(_.sum(transactionItemsByType.payables.map(entry => +entry.credit)))
      .about(10, 0.0001)

    // transfer amount paid by user to company supplying route
    expect(transactionItemsByType.transfer).exist()
    expect(transactionItemsByType.transfer.length).equal(1)
    expect(+transactionItemsByType.transfer[0].credit).about(5, 0.0001)
  })

  lab.test("Using routePass, userCredits, promoCodes together", {timeout: 20000}, async () => {
    var userId = userInstance.id
    const userCreditAmt = '5.00'
    var promoCode = randomString()

    await m.Credit.destroy({ where: { userId }})
    await m.Credit.create({ userId, balance: userCreditAmt})
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

    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await m.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let userUsageInst = await m.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: 0
    })

    let globalUsageInst = await m.PromoUsage.create({
      promoId: promoInst.id,
      userId: null,
      count: 0
    })

    const poItems = itemInsts.map(it => it.item)
    const poItems1 = [poItems[0]]
    const poItems2 = [poItems[1], poItems[2]]

    // promoCode is unnecessary in this purchase
    // Purchase 1 ticket, offset entirely by routePass,
    // but user proceeds to key in promoCode
    const saleResponse1 = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems1,
        stripeToken: await createStripeToken(),
        applyCredits: true,
        creditTag: testTag,
        promoCode: { code: promoCode, options: {} }
      },
      headers: authHeaders.user,
    })
    expect(saleResponse1.statusCode).to.equal(200)

    let transactionItems1 = saleResponse1.result.transactionItems
    expect(transactionItems1.length).equal(5)

    let sale1TIByType = _.groupBy(transactionItems1, ti => ti.itemType)
    expect(sale1TIByType.discount).not.exist()

    // userLimit and globalLimit should not increment
    await userUsageInst.reload()
    expect(userUsageInst.count).equal(0)

    await new Promise(resolve => setTimeout(resolve, 5000))

    await globalUsageInst.reload()
    expect(globalUsageInst.count).equal(0)

    // normal purchase
    // purchase 2 tickets, 1 offset by routePass,
    // remaining subsidised by promoCode and finally by credits
    const saleResponse2 = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems2,
        stripeToken: await createStripeToken(),
        applyCredits: true,
        applyRoutePass: true,
        promoCode: { code: promoCode, options: {} }
      },
      headers: authHeaders.user,
    })
    expect(saleResponse2.statusCode).to.equal(200)

    let transactionItems2 = saleResponse2.result.transactionItems
    expect(transactionItems2.length).equal(9)

    let sale2TIByType = _.groupBy(transactionItems2, ti => ti.itemType)

    expect(sale2TIByType.discount).exist()
    expect(sale2TIByType.discount.length).equal(1)
    expect(_.keys(sale2TIByType.discount[0].notes).length).equal(1)

    // userLimit and globalLimit should increment, but only by 1
    await userUsageInst.reload()
    expect(userUsageInst.count).equal(1)

    await new Promise(resolve => setTimeout(resolve, 5000))

    await globalUsageInst.reload()
    expect(globalUsageInst.count).equal(1)
  })
})
