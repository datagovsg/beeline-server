/* eslint no-await-in-loop: 0 */

const {db, models: m} = require('../src/lib/core/dbschema')()
const {
  resetTripInstances, loginAs, randomString, createStripeToken,
} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips, createTripInstancesFrom} from './test_data'
import {initBuilderWithTicketSale} from '../src/lib/transactions/builder'
import {routePassTagsFrom, applyRoutePass} from '../src/lib/transactions/routePass'

export const lab = Lab.script()

lab.experiment("Route Passes", function () {
  let userInstance
  let companyInstance
  let routeInstance
  let stopInstances
  let authHeaders = {}
  let testTag
  const ticketPrice = '5.00'
  const ticketsBought = 5
  let itemInsts = []
  let trips

  lab.before({timeout: 15000}, async function () {
    testTag = `rp-${Date.now()}`;

    ({userInstance, companyInstance, routeInstance, stopInstances, tripInstances: trips} =
        await createUsersCompaniesRoutesAndTrips(m, new Array(ticketsBought).fill(+ticketPrice)))

    await routeInstance.update({
      tags: [testTag],
    })

    trips.forEach((trip, i) => {
      itemInsts.push({
        item: {
          tripId: trip.id,
          boardStopId: trip.tripStops[0].id,
          alightStopId: trip.tripStops[2].id,
          userId: userInstance.id,
        },
        ticket: {id: i},
        price: trip.price,
        trip,
      })
    })

    let userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    let adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund', 'manage-routes'],
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    let superToken = (await loginAs('superadmin')).result.sessionToken
    authHeaders.super = { authorization: 'Bearer ' + superToken }
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get "user already has ticket" errors, or unexpected
    capacity errors
  */
  lab.beforeEach(async function () {
    await resetTripInstances(m, trips)
    await m.RoutePass.destroy({
      where: {userId: userInstance.id},
    })
  })

  lab.test('Route Passes work as part of a purchase order', async function () {
    const userId = userInstance.id
    const companyId = companyInstance.id

    // $5 credit...
    const pass = await m.RoutePass.create({
      companyId,
      userId,
      tag: testTag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: pass.id,
      debit: -ticketPrice,
    })

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await applyRoutePass(transactionBuilder, testTag)

    // Check the state before finalization...
    const items = withCredits.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding === 0 ||
        item.transactionItem.notes.outstanding === item.price)
    }

    const totalDiscount =
      _.sumBy(items, i => parseFloat(i.price)) -
      _.sumBy(items, i => parseFloat(i.transactionItem.notes.outstanding))
    const passCredit = +withCredits.transactionItemsByType.routePass[0].debit

    expect(totalDiscount).about(5, 0.002)
    expect(passCredit).about(5, 0.002)

    const finalized = await withCredits.finalizeForPayment(companyId)
    await finalized.build()

    await pass.reload()
    expect(pass.status).equal('void')
    await pass.destroy()
    await routePassPurchaseItem.destroy()
  })

  lab.test('Passes can only be applied to route with the correct tag', async function () {
    const userId = userInstance.id
    const companyId = companyInstance.id

    const pass = await m.RoutePass.create({
      companyId,
      userId,
      tag: 'NoSuchTag',
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: pass.id,
      debit: -ticketPrice,
    })

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await applyRoutePass(
      transactionBuilder, 'NoSuchTag')

    // Check the state before finalization...
    const items = withCredits.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding).equal(item.price * 1.0)
    }

    const totalDiscount =
      _.sumBy(items, i => parseFloat(i.price)) -
      _.sumBy(items, i => parseFloat(i.transactionItem.notes.outstanding))
    const passCredit = withCredits.transactionItemsByType.routePass

    expect(totalDiscount).equal(0)
    expect(passCredit).not.exist()

    await pass.reload()
    expect(pass.status).equal('valid')
    await pass.destroy()
    await routePassPurchaseItem.destroy()
  })

  lab.test('Route Pass tags extracted from transaction items', async function () {
    const makeTripItem = (routeId, tags) => ({ item: {}, trip: { routeId, route: {tags} } })
    const items = [
      makeTripItem(1, ['crowdstart-0', 'rp-1', 'others']),
      makeTripItem(2, ['rp-2', 'others']),
      makeTripItem(3, ['banana']),
      makeTripItem(2, ['rp-2', 'others']),
    ]
    const tags = await routePassTagsFrom(items)
    expect(tags).include('crowdstart-0')
    expect(tags).include('rp-2')
    expect(tags).to.have.length(3)
  })

  lab.test('Route Pass tags extracted from transaction items after checking user balances', async function () {
    const createRoutePass = async tag =>
      m.RoutePass.create({ userId: userInstance.id, companyId: companyInstance.id, tag, status: 'valid', notes: { price: +ticketPrice } })
    const passes = await Promise.all(['crowdstart-0', 'rp-1', 'rp-2'].map(createRoutePass))

    const routePassPurchaseItems = await Promise.all(
      passes.map(pass => m.TransactionItem.create({
        itemType: 'routePass',
        itemId: pass.id,
        debit: -ticketPrice,
      }))
    )

    const makeTripItem = (routeId, tags) => ({
      item: { userId: userInstance.id },
      trip: { routeId, route: { transportCompanyId: companyInstance.id, tags } },
    })
    const items = [
      makeTripItem(1, ['crowdstart-0', 'rp-1', 'others']),
      makeTripItem(2, ['crowdstart-1', 'rp-2', 'others']),
      makeTripItem(3, ['banana']),
    ]
    const tags = await routePassTagsFrom(items, m)
    expect(tags).include('crowdstart-0')
    expect(tags).include('rp-2')
    expect(tags).to.have.length(3)
    await Promise.all(passes.map(p => p.destroy()))
    await Promise.all(routePassPurchaseItems.map(p => p.destroy()))
  })

  lab.test('Passes work as part of a purchase order (2) -- full subsidy', async function () {
    const userId = userInstance.id
    const companyId = companyInstance.id

    // Create route passes, one per item
    const routePasses = await Promise.all(
      itemInsts.map(() => m.RoutePass.create({
        companyId,
        userId,
        tag: testTag,
        status: 'valid',
        notes: { price: +ticketPrice },
      }))
    )

    const routePassPurchaseItems = await Promise.all(
      routePasses.map(pass => m.TransactionItem.create({
        itemType: 'routePass',
        itemId: pass.id,
        debit: -ticketPrice,
      }))
    )

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withRoutePass = await applyRoutePass(transactionBuilder, testTag)

    // Check the state before finalization...
    const items = withRoutePass.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding).equal(0)
    }

    const totalPrice = _.sumBy(items, i => parseFloat(i.price))
    const passDebit = _.sumBy(
      withRoutePass.transactionItemsByType.routePass, i => parseFloat(i.debit)
    )

    expect(totalPrice).about(passDebit, 0.002)

    const finalized = await withRoutePass.finalizeForPayment(companyId)
    await finalized.build()

    for (const routePass of routePasses) {
      await routePass.reload()
      expect(routePass.status).equal('void')
      await routePass.destroy()
    }
    await Promise.all(routePassPurchaseItems.map(p => p.destroy()))
  })

  const testFloatingPointDiscrepancies = tripPrice => async () => {
    const userId = userInstance.id
    const companyId = companyInstance.id

    const trips = await createTripInstancesFrom(
      m,
      {routeInstance, companyInstance, stopInstances},
      [tripPrice, tripPrice, tripPrice]
    )

    const itemInsts = [
      {
        item: {
          tripId: trips[0].id,
          boardStopId: trips[0].tripStops[0].id,
          alightStopId: trips[0].tripStops[2].id,
          userId: userInstance.id,
        },
        ticket: {id: 0},
        price: trips[0].price,
        trip: trips[0],
      },
      {
        item: {
          tripId: trips[1].id,
          boardStopId: trips[1].tripStops[0].id,
          alightStopId: trips[1].tripStops[2].id,
          userId: userInstance.id,
        },
        ticket: {id: 1},
        price: trips[1].price,
        trip: trips[1],
      },
      {
        item: {
          tripId: trips[2].id,
          boardStopId: trips[2].tripStops[0].id,
          alightStopId: trips[2].tripStops[2].id,
          userId: userInstance.id,
        },
        ticket: {id: 2},
        price: trips[2].price,
        trip: trips[2],
      },
    ]

    // Create route passes, one per item
    const routePasses = await Promise.all(
      itemInsts.map(() => m.RoutePass.create({
        companyId,
        userId,
        tag: testTag,
        status: 'valid',
        notes: { price: +tripPrice },
      }))
    )

    const routePassPurchaseItems = await Promise.all(
      routePasses.map(pass => m.TransactionItem.create({
        itemType: 'routePass',
        itemId: pass.id,
        debit: -tripPrice,
      }))
    )

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withRoutePass = await applyRoutePass(transactionBuilder, testTag)

    // Check the state before finalization...
    const items = withRoutePass.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding).equal(0)
    }

    const totalPrice = _.sumBy(items, i => parseFloat(i.price))
    const passDebit = _.sumBy(
      withRoutePass.transactionItemsByType.routePass, i => parseFloat(i.debit)
    )

    expect(totalPrice).about(passDebit, 0.002)

    const finalized = await withRoutePass.finalizeForPayment(companyId)
    await finalized.build()

    for (const routePass of routePasses) {
      await routePass.reload()
      expect(routePass.status).equal('void')
      await routePass.destroy()
    }
    await m.Ticket.destroy({ truncate: true })
    await Promise.all(trips.map(t => t.destroy()))
    await Promise.all(routePassPurchaseItems.map(p => p.destroy()))
  }

  // SETUP:
  // Buying 3 x '4.2' Tickets
  // Expect total discounted (~12.6000001) > balance (12.60)
  lab.test(
    'Able to deal with floating point discrepancies (totalDiscounted > creditBalance)',
    testFloatingPointDiscrepancies(4.2)
  )

  // SETUP:
  // Buying 3 x '4.8' Tickets
  // Expect total discounted (~14.3999999) < balance (14.40)
  lab.test(
    'Able to deal with floating point discrepancies (totalDiscounted < creditBalance)',
    testFloatingPointDiscrepancies(4.8)
  )

  lab.test("Passes are voided after a purchase", {timeout: 30000}, async () => {
    const userId = userInstance.id
    const companyId = companyInstance.id

    // $5 credit...
    const routePass = await m.RoutePass.create({
      companyId: companyId,
      userId,
      tag: testTag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: routePass.id,
      debit: -ticketPrice,
    })

    const purchaseItems = [{
      tripId: trips[0].id,
      boardStopId: trips[0].tripStops[0].id,
      alightStopId: trips[0].tripStops[4].id,
    }, {
      tripId: trips[1].id,
      boardStopId: trips[1].tripStops[0].id,
      alightStopId: trips[1].tripStops[4].id,
    }]

    const previewResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: purchaseItems,
        applyRoutePass: true,
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user,
    })
    expect(previewResponse.statusCode).to.equal(200)

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems,
        applyRoutePass: true,
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(200)

    // Check that preview matches actual payment
    expect(previewResponse.result.transactionItems.find(it => it.itemType === 'routePass').debit === '5.00')
    expect(saleResponse.result.transactionItems.find(it => it.itemType === 'routePass').debit === '5.00')

    const previewPaymentAmount = previewResponse.result.transactionItems.find(it => it.itemType === 'payment').debit
    const salePaymentAmount = saleResponse.result.transactionItems.find(it => it.itemType === 'payment').debit
    expect(parseFloat(previewPaymentAmount)).equal(parseFloat(salePaymentAmount))

    // Check that the amount paid is discounted by $5
    const amountPaid = parseFloat(previewPaymentAmount)
    const sumPayments = _.sum(_.values(saleResponse.result.transactionItems.find(it => it.itemType === 'payment').notes.tickets))
    const sumCredits = _.sum(_.values(saleResponse.result.transactionItems.find(it => it.itemType === 'routePass').notes.tickets))

    expect(amountPaid).about(sumPayments, 0.0001)
    expect(sumCredits).about(5, 0.0001)

    const saleTIByType = _.groupBy(saleResponse.result.transactionItems, (ti) => ti.itemType)
    const refundedTicketItems = saleTIByType.ticketSale

    await routePass.reload()
    expect(routePass.status).equal('void')
    expect(routePass.notes.ticketId).exist()
    await routePass.destroy()
    await routePassPurchaseItem.destroy()

    for (let refundedTicketItem of refundedTicketItems) {
      const refundResponse = await server.inject({ // eslint-disable-line no-await-in-loop
        method: "POST",
        url: `/transactions/tickets/${refundedTicketItem.itemId}/refund/route_pass`,
        payload: {
          targetAmt: refundedTicketItem.credit,
          tag: testTag,
        },
        headers: authHeaders.admin,
      })
      expect(refundResponse.statusCode).to.equal(200)

      const refundTIByType = _.groupBy(refundResponse.result.transactionItems, ti => ti.itemType)
      expect(refundTIByType.routePass.length).equal(1)
      expect(+refundTIByType.routePass[0].credit).equal(5)
    }

    // Check credits are restored
    const routePassInstances = await m.RoutePass.findAll({ where: {userId, companyId, tag: testTag} })
    const routePasses = routePassInstances.map(r => r.toJSON())
    expect(_(routePasses).map('notes').map('refundedTicketId').sort().value())
      .equal(_(refundedTicketItems).map('itemId').sort().value())
    await Promise.all(routePassInstances.map(r => r.destroy()))
  })

  lab.test("Route pass remains valid after a failed purchase", {timeout: 10000}, async () => {
    const userId = userInstance.id
    const companyId = companyInstance.id

    // $5 credit...
    const routePass = await m.RoutePass.create({
      companyId: companyId,
      userId,
      tag: testTag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })
    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: routePass.id,
      debit: -ticketPrice,
    })

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: trips[0].id,
          boardStopId: trips[0].tripStops[0].id,
          alightStopId: trips[0].tripStops[4].id,
        }, {
          tripId: trips[1].id,
          boardStopId: trips[1].tripStops[0].id,
          alightStopId: trips[1].tripStops[4].id,
        }, {
          tripId: trips[2].id,
          boardStopId: trips[2].tripStops[0].id,
          alightStopId: trips[2].tripStops[4].id,
        }, {
          tripId: trips[3].id,
          boardStopId: trips[3].tripStops[0].id,
          alightStopId: trips[3].tripStops[4].id,
        }, {
          tripId: trips[4].id,
          boardStopId: trips[4].tripStops[0].id,
          alightStopId: trips[4].tripStops[4].id,
        }],
        stripeToken: 'Fake stripe token',
        applyRoutePass: true,
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(402)

    await routePass.reload()
    expect(routePass.status).equal('valid')
    await routePass.destroy()
    await routePassPurchaseItem.destroy()
  })

  lab.test('Passes can be purchased (token not saved)', {timeout: 20000}, async function () {
    const userId = userInstance.id
    const tag = testTag
    const companyId = companyInstance.id

    // Purchase some credits for this route
    const purchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 2,
        tag,
        stripeToken: await createStripeToken(),
        companyId: companyInstance.id,
      },
      headers: authHeaders.user,
    })
    expect(purchaseResponse.statusCode).equal(200)

    // Check that the credits have been updated :)
    const passes = await m.RoutePass.findAll({
      where: { userId, companyId, tag, status: 'valid' },
    })
    expect(passes.length).equal(2)
    await Promise.all(passes.map(p => p.destroy()))
  })

  lab.test('Passes can be purchased (token saved)', {timeout: 20000}, async function () {
    const userId = userInstance.id
    const tag = testTag
    const companyId = companyInstance.id

    // Insert some credit card details
    const postResponse = await server.inject({
      method: 'POST',
      url: `/users/${userId}/creditCards`,
      headers: authHeaders.user,
      payload: {
        stripeToken: await createStripeToken(),
      },
    })
    expect(postResponse.statusCode).equal(200)

    // Purchase some credits for this route
    const purchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 2,
        tag: testTag,
        companyId: companyInstance.id,
        customerId: postResponse.result.id,
        sourceId: postResponse.result.sources.data[0].id,
      },
      headers: authHeaders.user,
    })
    expect(purchaseResponse.statusCode).equal(200)

    // Check that the credits have been updated :)
    const passes = await m.RoutePass.findAll({
      where: { userId, companyId, tag, status: 'valid' },
    })
    expect(passes.length).equal(2)
    await Promise.all(passes.map(p => p.destroy()))
  })

  lab.test('Discount on route passes purchased', {timeout: 30000}, async function () {
    // Create the discount
    const code = `promo-${Date.now()}`
    const promotion = await m.Promotion.create({
      code,
      type: 'RoutePass',
      params: {
        tag: testTag,
        refundFunction: {
          type: 'refundDiscountedAmt',
        },
        discountFunction: {
          type: 'tieredRateByTotalValue',
          params: {
            schedule: [
              [20, 0.1],
              [40, 0.2],
            ],
          },
        },
        usageLimit: {
          globalLimit: 4,
          userLimit: 4,
        },
        qualifyingCriteria: [],
      },
      description: 'Bulk discounts for route pass purchase',
    })

    // Purchase some credits for this route
    // Returns [paid amount, discounted amount]
    const submitPurchase = async function submitPurchase (amount) {
      return server.inject({
        method: 'POST',
        url: `/transactions/route_passes/payment`,
        payload: {
          value: amount,
          promoCode: {
            code,
          },
          tag: testTag,
          stripeToken: await createStripeToken(),
          companyId: companyInstance.id,
        },
        headers: authHeaders.user,
      })
    }

    const purchase = async function purchase (amount) {
      const purchaseResponse = await submitPurchase(amount)
      expect(purchaseResponse.statusCode, `Purchase of $${amount}`).equal(200)

      // Check that the credits have been updated, and discounts
      // have been applied
      const tiByTypes = _.groupBy(purchaseResponse.result.transactionItems, 'itemType')

      return [
        tiByTypes.payment[0].debit,
        tiByTypes.discount[0].debit,
      ]
    }

    const [p1, d1] = await purchase(15.00)
    expect(p1).equal('15.00')
    expect(d1).equal('0.00')

    // 10 percent
    const [p2, d2] = await purchase(20.00)
    expect(p2).equal('18.00')
    expect(d2).equal('2.00')

    // 10 percent
    const [p3, d3] = await purchase(35.00)
    expect(p3).equal('31.50')
    expect(d3).equal('3.50')

    // 20 percent
    const [p4, d4] = await purchase(40.00)
    expect(p4).equal('32.00')
    expect(d4).equal('8.00')

    const userUsage = await m.PromoUsage.find({ where: { promoId: promotion.id, userId: userInstance.id }})
    expect(userUsage.count).equal(4)
    // FIXME: We have to figure out how to express an expect that is _eventually_ true
    // const globalUsage = await m.PromoUsage.find({ where: { promoId: promotion.id, userId: null }});
    // expect(globalUsage.count).equal(4);

    await promotion.update({
      'params.usageLimit': {
        globalLimit: 5,
        userLimit: 4,
      },
    })
    let lateResponse = await submitPurchase(40.00)
    expect(lateResponse.statusCode).equal(400)
    expect(lateResponse.result.message).include('You')

    await promotion.update({
      'params.usageLimit': {
        globalLimit: 4,
        userLimit: 5,
      },
    })
    lateResponse = await submitPurchase(40.00)
    expect(lateResponse.statusCode).equal(400)
    expect(lateResponse.result.message).include('fully')
  })


  lab.test('Add/subtract promo usage', {timeout: 30000}, async function () {
    // Create the discount
    const code = `promo-${Date.now()}`
    const promotion = await m.Promotion.create({
      code,
      type: 'RoutePass',
      params: {
        tag: testTag,
        refundFunction: {
          type: 'refundDiscountedAmt',
        },
        discountFunction: {
          type: 'tieredRateByTotalValue',
          params: {
            schedule: [
              [20, 0.1],
              [40, 0.2],
            ],
          },
        },
        usageLimit: {
          globalLimit: 4,
          userLimit: 4,
        },
        qualifyingCriteria: [],
      },
      description: 'Bulk discounts for route pass purchase',
    })

    await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 2,
        promoCode: {
          code,
        },
        tag: testTag,
        stripeToken: await createStripeToken(),
        companyId: companyInstance.id,
      },
      headers: authHeaders.user,
    })

    let userUsage = await m.PromoUsage.find({ where: { promoId: promotion.id, userId: userInstance.id }})
    expect(userUsage.count).equal(1)

    await m.PromoUsage.subtractUserPromoUsage(promotion.id, userInstance.id, 1, {})
    userUsage = await m.PromoUsage.find({ where: { promoId: promotion.id, userId: userInstance.id }})
    expect(userUsage.count).equal(0)

    await m.PromoUsage.subtractGlobalPromoUsage(promotion.id, 1, {})
    const globalUsage = await m.PromoUsage.find({ where: { promoId: promotion.id, userId: null }})
    expect(globalUsage.count).equal(0)
  })

  lab.test('Passes can be individually refunded', {timeout: 20000}, async function () {
    const userId = userInstance.id
    const tag = testTag
    const companyId = companyInstance.id

    // Purchase some credits for this route
    const purchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 2,
        tag,
        stripeToken: await createStripeToken(),
        companyId: companyInstance.id,
      },
      headers: authHeaders.user,
    })
    expect(purchaseResponse.statusCode).equal(200)
    const routePassTxnItems = purchaseResponse.result.transactionItems
      .filter(i => i.itemType === 'routePass')

    // Check that the credits have been updated :)
    const passes = await m.RoutePass.findAll({
      where: { userId, companyId, tag, status: 'valid' },
    })
    expect(passes.length).equal(2)

    const refundRoutePass = async routePassTxnItem => {
      const response = await server.inject({
        method: 'POST',
        url: `/transactions/route_passes/${routePassTxnItem.itemId}/refund/payment`,
        payload: {
          transactionItemId: routePassTxnItem.id,
        },
        headers: authHeaders.admin,
      })
      expect(response.statusCode).equal(200)
      const refundPayments = response.result.transactionItems.map(t => t.refundPayment).filter(Boolean)
      expect(refundPayments.length).equal(1)
      return refundPayments[0]
    }

    const refundPayments = await Promise.all(routePassTxnItems.map(refundRoutePass))

    // Ensure refunds are unique, one per route pass, but relate to the same charge
    expect(refundPayments[0].paymentResource).not.equal(refundPayments[1].paymentResource)
    expect(refundPayments[0].data.charge).equal(refundPayments[1].data.charge)

    await Promise.all(passes.map(p => p.reload()))
    expect(passes.filter(p => p.status === 'refunded').length).equal(passes.length)

    await Promise.all(passes.map(p => p.destroy()))
  })

  lab.test('Multiple passes can be applied', async function () {
    // Set up the multiple tags
    // 1. Create the tags
    // 2. Add some value to them
    // 3. Add the tags to the route
    const tags = (() => {
      const tagBase = randomString()
      return _.range(0, 10).map(i => `rp-${tagBase}-${i}`)
    })()
    const passes = await Promise.all(tags.map(tag => m.RoutePass.create({
      companyId: companyInstance.id,
      userId: userInstance.id,
      tag,
      status: 'valid',
      notes: { price: +1 },
    })))

    const routePassPurchaseItems = await Promise.all(
      passes.map(pass => m.TransactionItem.create({
        itemType: 'routePass',
        itemId: pass.id,
        debit: -1,
      }))
    )

    routeInstance.tags = routeInstance.tags.concat(tags)
    await routeInstance.save()

    try {
      const purchaseItems = [{
        tripId: trips[0].id,
        boardStopId: trips[0].tripStops[0].id,
        alightStopId: trips[0].tripStops[4].id,
      }, {
        tripId: trips[1].id,
        boardStopId: trips[1].tripStops[0].id,
        alightStopId: trips[1].tripStops[4].id,
      }]

      expect(trips[0].priceF + trips[1].priceF).most(15)

      const saleResponse = await server.inject({
        method: "POST",
        url: "/transactions/tickets/payment",
        payload: {
          trips: purchaseItems,
          applyRoutePass: true,
          stripeToken: 'SHOULDN\'T NEED ONE',
        },
        headers: authHeaders.user,
      })

      expect(saleResponse.statusCode).equal(200)
      // Expect 3 account entries - 1 COGS and 2 Route Pass valuation adjustments
      expect(saleResponse.result.transactionItems.filter(i => i.itemType === 'account').length).equal(3)

      await Promise.all(passes.map(p => p.reload()))
      const passesRemaining = _(passes)
        .filter(p => p.status === 'valid')
        .value()
        .length

      expect(passesRemaining).equal(8)
    } finally {
      /* Remove the spurious tags for subsequent tests */
      routeInstance.tags = _.difference(routeInstance.tags, tags)
      await routeInstance.save()
      await Promise.all(routePassPurchaseItems.map(i => i.destroy()))
    }
  })
})
