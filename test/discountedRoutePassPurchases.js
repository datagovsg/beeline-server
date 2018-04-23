import Lab from 'lab'
export const lab = Lab.script()

import {expect} from 'code'
import _ from 'lodash'

import server from '../src/index.js'
import {resetTripInstances, loginAs, createStripeToken, cleanlyDeletePromotions} from './test_common'
import * as testData from './test_data'
const Payment = require("../src/lib/transactions/payment")
const stripe = Payment.stripe

const {models} = require("../src/lib/core/dbschema")()

lab.experiment("Integration with route pass transaction", function () {
  let userInstance
  let authHeaders = {}

  let companyInstance
  let routeInstance
  let customerInfo
  let stopInstances = []
  let tripInstances = []

  lab.beforeEach(() => models.RoutePass.destroy({ truncate: true }))
  lab.afterEach(async () => resetTripInstances(models, tripInstances))

  lab.before({timeout: 15000}, async () => {
    ({userInstance, companyInstance, tripInstances, stopInstances, routeInstance} =
      await testData.createUsersCompaniesRoutesAndTrips(models))

    let userToken = userInstance.makeToken()
    authHeaders.user = {authorization: "Bearer " + userToken}

    const stripeToken = await createStripeToken()
    const c = await stripe.customers.create({
      source: stripeToken,
      metadata: {
        userId: userInstance.id,
      },
    })
    customerInfo = await stripe.customers.retrieve(c.id)

    let adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund'],
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    await cleanlyDeletePromotions({code: 'TEST PROMO'})
    const promotion = await models.Promotion.create({
      code: 'TEST PROMO',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.1},
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })
    await routeInstance.update({ tags: ['public', promotion.params.tag] })
    await Promise.all(tripInstances.map(t => t.update({ price: '5' })))
  })

  lab.after({timeout: 10000}, async () => {
    await models.RoutePass.destroy({ truncate: true })
    await Promise.all(tripInstances.map(instance => instance.destroy()))
    await Promise.all(stopInstances.map(instance => instance.destroy()))
    await routeInstance.destroy()
    await companyInstance.destroy()
    await userInstance.destroy()
  })

  lab.test("Route pass purchase with promo code", {timeout: 10000}, async () => {
    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/payment",
      payload: {
        value: 50,
        tag: 'TESTTAG',
        companyId: companyInstance.id,

        customerId: customerInfo.id,
        sourceId: customerInfo.sources.data[0].id,
        promoCode: {
          code: 'TEST PROMO',
          options: {},
        },
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(5)

    expect(saleResponse.result.description).include('TEST PROMO')
    expect(saleResponse.result.description).include(items.discount[0].debit)
    await cleanlyDeletePromotions({code: 'TEST PROMO'})
  })

  lab.test("Route pass purchase with promo code and expected price", {timeout: 10000}, async () => {
    await models.Promotion.create({
      code: 'TEST PROMO',
      type: 'RoutePass',
      params: {
        "description": "Bad promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.1},
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })
    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/payment",
      payload: {
        value: 50,
        tag: 'TESTTAG',
        companyId: companyInstance.id,
        expectedPrice: 46,
        customerId: customerInfo.id,
        sourceId: customerInfo.sources.data[0].id,
        promoCode: {
          code: 'TEST PROMO',
          options: {},
        },
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(400)
    await cleanlyDeletePromotions({code: 'TEST PROMO'})
  })

  lab.test("Default promotions does not throw error if it does not exist", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})

    const payload = {
      value: 50,
      tag: 'TESTTAG',
      companyId: companyInstance.id,

      customerId: customerInfo.id,
      sourceId: customerInfo.sources.data[0].id,
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })

    expect(saleResponse.statusCode).equal(200)

    expect(saleResponse.result.transactionItems
      .find(ti => ti.itemType === 'discount')).not.exist()

    const paymentValue = saleResponse.result.transactionItems
      .find(ti => ti.itemType === 'payment')
      .debit

    expect(parseFloat(paymentValue)).equal(50)
  })

  lab.test("Best promo applied when > 1 have same promo code", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})
    await models.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "Bad promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.1},
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })

    await models.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "Better promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.2},
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })

    const payload = {
      value: 50,
      tag: 'TESTTAG',
      companyId: companyInstance.id,

      customerId: customerInfo.id,
      sourceId: customerInfo.sources.data[0].id,
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(10)

    expect(saleResponse.result.description).include(items.discount[0].debit)
  })

  lab.test("Credit for route rp-1337 discounted by promo tagged TESTTAG", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})

    await models.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "Better promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.2},
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })

    const tag = 'rp-1337'
    await routeInstance.update({ tags: ['TESTTAG', tag] })

    const payload = {
      value: 50,
      tag,
      companyId: companyInstance.id,

      customerId: customerInfo.id,
      sourceId: customerInfo.sources.data[0].id,
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(10)

    expect(saleResponse.result.description).include(items.discount[0].debit)

    const routePasses = await models.RoutePass.findAll({
      where: { userId: userInstance.id, companyId: companyInstance.id, tag },
    })
    expect(routePasses.length).equal(10)
  })

  lab.test("Credit for route discounted by tieredRateByTotalValue", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})

    await models.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "Better promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "tieredRateByTotalValue",
          "params": {
            "schedule": [
              [50, 0.2],
              [100, 0.4],
            ],
          },
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })

    const tag = 'TESTTAG'
    await routeInstance.update({ tags: [tag] })

    const payload = {
      value: 50,
      tag,
      companyId: companyInstance.id,

      customerId: customerInfo.id,
      sourceId: customerInfo.sources.data[0].id,
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(10)

    expect(saleResponse.result.description).include(items.discount[0].debit)

    payload.value = 100

    const saleResponse2 = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse2.statusCode).to.equal(200)

    items = _.groupBy(saleResponse2.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(40)

    expect(saleResponse2.result.description).include(items.discount[0].debit)

    const routePasses = await models.RoutePass.findAll({
      where: { userId: userInstance.id, companyId: companyInstance.id, tag },
    })
    expect(routePasses.length).equal(30)
  })

  lab.test("Credit for route discounted by tieredRateByTotalValue for only one user", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})

    const contactListInstance = await models.ContactList.create({
      transportCompanyId: routeInstance.transportCompanyId,
      telephones: [userInstance.telephone],
      emails: [],
    })

    await models.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "Better promo",
        "tag": "TESTTAG",
        "qualifyingCriteria": [{
          "type": "limitByContactList",
          "params": { "contactListId": contactListInstance.id },
        }],
        "discountFunction": {
          "type": "tieredRateByTotalValue",
          "params": {
            "schedule": [
              [50, 0.2],
              [100, 0.4],
            ],
          },
        },
        "refundFunction": {
          "type": "refundDiscountedAmt",
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null,
        },
      },
    })

    const tag = 'TESTTAG'
    await routeInstance.update({ tags: [tag] })

    const payload = {
      value: 50,
      tag,
      companyId: companyInstance.id,

      customerId: customerInfo.id,
      sourceId: customerInfo.sources.data[0].id,
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(10)

    expect(saleResponse.result.description).include(items.discount[0].debit)

    payload.value = 100

    const saleResponse2 = await server.inject({
      method: 'POST',
      url: "/transactions/route_passes/payment",
      payload,
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse2.statusCode).to.equal(200)

    items = _.groupBy(saleResponse2.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).to.equal(40)

    expect(saleResponse2.result.description).include(items.discount[0].debit)

    const routePasses = await models.RoutePass.findAll({
      where: { userId: userInstance.id, companyId: companyInstance.id, tag },
    })
    expect(routePasses.length).equal(30)
  })
})
