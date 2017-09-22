import Lab from 'lab'
import _ from 'lodash'
import server from '../src/index.js'
import {expect} from 'code'

import {resetTripInstances, loginAs, cleanlyDeletePromotions,
        randomString, createStripeToken, randomEmail} from './test_common'
import {createUsersCompaniesRoutesAndTrips} from './test_data'

export const lab = Lab.script()
const {db, models} = require('../src/lib/core/dbschema')()

lab.experiment("Promotion usage", function () {
  var authHeaders = {}, templates = null
  var userInstance, companyInstance, tripInstances
  var globalLimit = 50
  var userLimit = 3

  lab.before({timeout: 15000}, async () => {
    ({userInstance, companyInstance, tripInstances} =
      await createUsersCompaniesRoutesAndTrips(models))

    var userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    var adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    templates = {
      connection: {db, models, dryRun: false, committed: true},
      items: [
        {
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[2].id,
        },
        {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[2].id,
        },
        {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[2].id,
        }
      ],
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
          globalLimit,
          userLimit
        }
      }
    }
  })

  lab.afterEach(async () => resetTripInstances(models, tripInstances))

  lab.test('Hit User Limit', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let promoUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: userLimit
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })

  lab.test('userLimit is a hard limit', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let promoUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: userLimit - 1
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(200)

    let saleTIByType = _.groupBy(saleResponse.result.transactionItems, ti => ti.itemType)

    // expect only 1 of the 3 tickets to have received the discount due to user limit
    expect(saleTIByType.discount).exists()
    expect(saleTIByType.discount.length).equal(1)
    expect(_.keys(saleTIByType.discount[0].discount.discountAmounts).length).equal(1)
  })

  lab.test('Hit Global Limit', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    var randomUser = await models.User.create({telephone: randomEmail()})

    let userUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: randomUser.id,
      count: globalLimit
    })

    let globalUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: null,
      count: globalLimit
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })

  lab.test('Track promoUsage', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let userUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: 0
    })

    let globalUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: null,
      count: 0
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(200)

    await userUsageInst.reload()
    expect(userUsageInst.count).equal(poItems.length)

    await new Promise(resolve => setTimeout(resolve, 5000))

    await globalUsageInst.reload()
    expect(globalUsageInst.count).equal(poItems.length)
  })

  lab.test('Revert on bad purchase', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let userUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: 0
    })

    let globalUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: null,
      count: 0
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: 'BADSTRIPE',
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(402)

    await userUsageInst.reload()
    expect(userUsageInst.count).equal(0)

    await new Promise(resolve => setTimeout(resolve, 5000))

    await globalUsageInst.reload()
    expect(globalUsageInst.count).equal(0)
  })

  lab.test('Does not trigger update on preview', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    let userUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: userInstance.id,
      count: 0
    })

    let globalUsageInst = await models.PromoUsage.create({
      promoId: promoInst.id,
      userId: null,
      count: 0
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(200)

    await userUsageInst.reload()
    expect(userUsageInst.count).equal(0)

    await new Promise(resolve => setTimeout(resolve, 5000))

    await globalUsageInst.reload()
    expect(globalUsageInst.count).equal(0)
  })


  lab.test('Disallow usage by setting globalLimit to 0', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoParams = {
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
        globalLimit: 0,
        userLimit
      }
    }

    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: promoParams,
      description: `Test promo ${Date.now()}`
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })

  lab.test('Disallow usage by setting userLimit to 0', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoParams = {
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
        globalLimit,
        userLimit: 0
      }
    }

    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: promoParams,
      description: `Test promo ${Date.now()}`
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })

  lab.test('Existing promotions without usageLimit will break', {timeout: 20000}, async () => {
    var promoCode = randomString()

    // Create the promo
    await cleanlyDeletePromotions({code: promoCode})
    let promoParams = {
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
      // usageLimit: {
      //   globalLimit,
      //   userLimit: 0
      // }
    }

    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: promoParams,
      description: `Test promo ${Date.now()}`
    })

    const poItems = templates.items

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })
})
