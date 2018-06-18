import Lab from 'lab'
export const lab = Lab.script()

import {expect} from 'code'
import _ from 'lodash'

import {roundToNearestCent} from '../src/lib/util/common'

import server from '../src/index.js'
import {
  resetTripInstances, loginAs, createStripeToken,
  cleanlyDeleteUsers, randomEmail, cleanlyDeletePromotions,
} from './test_common'
import * as testData from './test_data'

const {models} = require("../src/lib/core/dbschema")()

lab.experiment("Integration with transaction", function () {
  let userInstance
  let authHeaders = {}

  // var testName = "Name for Testing";
  // var updatedTestName = "Updated name for Testing";

  let companyInstance
  let routeInstance
  let stopInstances = []
  let tripInstances = []

  lab.afterEach(async () => resetTripInstances(models, tripInstances))

  lab.before({timeout: 15000}, async () => {
    ({userInstance, companyInstance, tripInstances, stopInstances, routeInstance} =
        await testData.createUsersCompaniesRoutesAndTrips(models))

    const userToken = userInstance.makeToken()
    authHeaders.user = {authorization: "Bearer " + userToken}

    const adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund', 'issue-tickets'],
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    await cleanlyDeletePromotions({code: 'TEST PROMO'})
    await models.Promotion.create({
      code: 'TEST PROMO',
      type: 'Promotion',
      params: {
        "description": "For test",
        "qualifyingCriteria": [{
          "type": "noLimit",
        }],
        "discountFunction": {
          "type": "tieredRateByQty",
          "params": {"schedule": [[5, 0.2]]},
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
  })

  lab.after({timeout: 10000}, async () => {
    await Promise.all(tripInstances.map(instance => instance.destroy()))
    await Promise.all(stopInstances.map(instance => instance.destroy()))
    await routeInstance.destroy()
    await companyInstance.destroy()
    await userInstance.destroy()
  })

  lab.test("Dry run ticket purchase with promoCode", {timeout: 10000}, async () => {
    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[4].id,
        }, {
          tripId: tripInstances[3].id,
          boardStopId: tripInstances[3].tripStops[0].id,
          alightStopId: tripInstances[3].tripStops[4].id,
        }, {
          tripId: tripInstances[4].id,
          boardStopId: tripInstances[4].tripStops[0].id,
          alightStopId: tripInstances[4].tripStops[4].id,
        }],
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
    expect(parseFloat(items.discount[0].debit)).to.equal(6.05)

    expect(saleResponse.result.description).include('TEST PROMO')
    expect(saleResponse.result.description).include(items.discount[0].debit.toFixed(2))
  })

  lab.test("Refund after discount", {timeout: 15000}, async () => {
    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[4].id,
        }, {
          tripId: tripInstances[3].id,
          boardStopId: tripInstances[3].tripStops[0].id,
          alightStopId: tripInstances[3].tripStops[4].id,
        }, {
          tripId: tripInstances[4].id,
          boardStopId: tripInstances[4].tripStops[0].id,
          alightStopId: tripInstances[4].tripStops[4].id,
        }],
        promoCode: {
          code: 'TEST PROMO',
          options: {},
        },
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(200)

    const tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    const ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    const ticketPrice = +tripInstances[0].price
    const discount = ticket.notes.discountValue

    // Refund a ticket...
    const refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: ticketPrice - discount,
      },
      headers: authHeaders.admin,
    })
    expect(refundResponse.statusCode).to.equal(200)

    const items = _.groupBy(refundResponse.result.transactionItems, 'itemType')

    expect(parseFloat(items.ticketRefund[0].debit)).to.equal(5.85)
  })


  lab.test("Promotions limited by telephone lists work", {timeout: 10000}, async function () {
    const randomTelephoneNumbersInList = [
      '+601234560',
      '+601234561',
      '+601234562',
      '+601234563',
    ]
    const randomTelephoneNumbersNotInList = [
      '+601234564',
      '+601234565',
      '+601234566',
      '+601234567',
    ]

    // Create the list in the database directly to bypass validation
    const contactList = await models.ContactList.create({
      transportCompanyId: companyInstance.id,
      description: 'Blah',
      telephones: randomTelephoneNumbersInList,
      emails: [],
    })

    // Create a promotion
    const promotion = await models.Promotion.create({
      code: 'TEST TELEPHONE LIST PROMO',
      type: 'Promotion',
      params: {
        "description": "For test",
        "qualifyingCriteria": [{
          type: "limitByContactList",
          params: {
            contactListId: contactList.id,
          },
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.4},
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

    // User 1 -- in the list
    await cleanlyDeleteUsers({
      telephone: {$in: randomTelephoneNumbersInList.concat(randomTelephoneNumbersNotInList)},
    })

    const userInList = await models.User.create({
      telephone: randomTelephoneNumbersInList[1],
    })
    const userNotInList = await models.User.create({
      telephone: randomTelephoneNumbersNotInList[1],
    })

    const samplePayload = {
      trips: [{
        tripId: tripInstances[0].id,
        boardStopId: tripInstances[0].tripStops[0].id,
        alightStopId: tripInstances[0].tripStops[4].id,
      }, {
        tripId: tripInstances[1].id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[4].id,
      }],
      promoCode: {
        code: 'TEST TELEPHONE LIST PROMO',
        options: {},
      },
    }

    const failResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userNotInList.makeToken()}`,
      },
    })
    expect(failResponse.statusCode).equal(400)

    const successResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userInList.makeToken()}`,
      },
    })
    expect(successResponse.result.transactionItems.find(ti =>
      ti.itemType === 'discount' && ti.discount.code === promotion.code))
    expect(successResponse.statusCode).equal(200)
  })

  lab.test("Promotions limited by email work", {timeout: 10000}, async function () {
    const randomEmailInList = _.range(0, 4).map(randomEmail)
    const randomEmailNotInList = _.range(0, 4).map(randomEmail)

    // Create the list in the database directly to bypass validation
    const contactList = await models.ContactList.create({
      transportCompanyId: companyInstance.id,
      description: 'Blah',
      emails: randomEmailInList,
      telephones: [],
    })

    // Create a promotion
    const promotion = await models.Promotion.create({
      code: 'TEST EMAIL LIST PROMO',
      type: 'Promotion',
      params: {
        "description": "For test",
        "qualifyingCriteria": [{
          type: "limitByContactList",
          params: {
            contactListId: contactList.id,
          },
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.4},
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

    // User 1 -- in the list
    await cleanlyDeleteUsers({
      telephone: {$in: randomEmailInList.concat(randomEmailNotInList)},
    })

    const userInList = await models.User.create({
      email: randomEmailInList[1],
      emailVerified: true,
    })
    const unverifiedUserInList = await models.User.create({
      email: randomEmailInList[2],
      emailVerified: false,
    })
    const userNotInList = await models.User.create({
      email: randomEmailNotInList[1],
      emailVerified: true,
    })

    const samplePayload = {
      trips: [{
        tripId: tripInstances[0].id,
        boardStopId: tripInstances[0].tripStops[0].id,
        alightStopId: tripInstances[0].tripStops[4].id,
      }, {
        tripId: tripInstances[1].id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[4].id,
      }],
      promoCode: {
        code: promotion.code,
        options: {},
      },
    }

    const failResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userNotInList.makeToken()}`,
      },
    })
    expect(failResponse.statusCode).equal(400)

    const failResponse2 = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${unverifiedUserInList.makeToken()}`,
      },
    })
    expect(failResponse2.statusCode).equal(400)

    const successResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userInList.makeToken()}`,
      },
    })
    expect(successResponse.statusCode).equal(200)
    expect(successResponse.result.transactionItems.find(ti =>
      ti.itemType === 'discount' && ti.discount.code === promotion.code))
  })

  lab.test("Default promotions work", {timeout: 10000}, async function () {
    let promotion

    try {
      // Create a promotion
      promotion = await models.Promotion.create({
        code: '',
        type: 'Promotion',
        params: {
          "description": "Bulk discount promo",
          "qualifyingCriteria": [{
            type: 'limitByCompany',
            params: {companyId: companyInstance.id},
          }],
          "discountFunction": {
            "type": "simpleRate",
            "params": {"rate": 0.4},
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

      const samplePayload = {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }],
        promoCode: {
          code: '',
          options: {},
        },
      }

      const saleResponse = await server.inject({
        method: 'POST',
        url: "/transactions/tickets/payment",
        payload: {
          ...samplePayload,
          stripeToken: await createStripeToken(),
        },
        headers: {
          authorization: `Bearer ${userInstance.makeToken()}`,
        },
      })

      expect(saleResponse.statusCode).equal(200)

      const discountValue = saleResponse.result.transactionItems
        .find(ti => ti.itemType === 'discount')
        .debit

      const paymentValue = saleResponse.result.transactionItems
        .find(ti => ti.itemType === 'payment')
        .debit

      expect(parseFloat(paymentValue) / parseFloat(discountValue))
        .about(3 / 2, 0.001)
    } catch (err) {
      throw err
    } finally {
      if (promotion) await promotion.destroy()
    }
  })

  lab.test("Default promotions does not throw error if it does not exist", {timeout: 10000}, async function () {
    try {
      await models.Promotion.destroy({
        where: {
          code: '',
        },
      })

      const samplePayload = {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }],
        promoCode: {
          code: '',
          options: {},
        },
      }

      const saleResponse = await server.inject({
        method: 'POST',
        url: "/transactions/tickets/payment",
        payload: {
          ...samplePayload,
          stripeToken: await createStripeToken(),
        },
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

      expect(parseFloat(paymentValue)).about(tripInstances[0].priceF + tripInstances[1].priceF, 0.001)
    } catch (err) {
      throw err
    }
  })

  lab.test("Best promo applied when > 1 have same promo code", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})
    await models.Promotion.create({
      code: '',
      type: 'Promotion',
      params: {
        "description": "Bad promo",
        "qualifyingCriteria": [{
          type: 'limitByCompany',
          params: {companyId: companyInstance.id},
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.4},
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
      type: 'Promotion',
      params: {
        "description": "Better promo",
        "qualifyingCriteria": [{
          type: 'limitByCompany',
          params: {companyId: companyInstance.id},
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.5},
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

    const samplePayload = {
      trips: [{
        tripId: tripInstances[0].id,
        boardStopId: tripInstances[0].tripStops[0].id,
        alightStopId: tripInstances[0].tripStops[4].id,
      }, {
        tripId: tripInstances[1].id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[4].id,
      }],
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).about(
      roundToNearestCent(tripInstances[0].price * 0.5) +
      roundToNearestCent(tripInstances[1].price * 0.5),
      0.0001
    )

    expect(saleResponse.result.description).include(items.discount[0].debit)
  })

  lab.test("Best promo applied when > 1 have same promo code but diff discount functions", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})
    await models.Promotion.create({
      code: '',
      type: 'Promotion',
      params: {
        "description": "Bad promo",
        "qualifyingCriteria": [{
          type: 'limitByCompany',
          params: {companyId: companyInstance.id},
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.4},
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


    // Create the list in the database directly to bypass validation
    const contactList = await models.ContactList.create({
      transportCompanyId: companyInstance.id,
      description: 'Blah',
      telephones: [userInstance.telephone],
      emails: [],
    })

    await models.Promotion.create({
      code: '',
      type: 'Promotion',
      params: {
        "description": "Better promo",
        "qualifyingCriteria": [{
          type: "limitByContactList",
          params: {
            contactListId: contactList.id,
          },
        }, {
          type: 'limitByMinTicketCount',
          params: {n: 2},
        }, {
          type: 'limitByCompany',
          params: {companyId: companyInstance.id},
        }],
        "discountFunction": {
          type: 'fixedTransactionPrice',
          params: {price: 1},
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

    const samplePayload = {
      trips: [{
        tripId: tripInstances[0].id,
        boardStopId: tripInstances[0].tripStops[0].id,
        alightStopId: tripInstances[0].tripStops[4].id,
      }, {
        tripId: tripInstances[1].id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[4].id,
      }],
      promoCode: {
        code: '',
        options: {},
      },
    }

    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)

    let items = _.groupBy(saleResponse.result.transactionItems, 'itemType')
    expect(items.discount.length).to.equal(1)
    expect(parseFloat(items.discount[0].debit)).about(
      roundToNearestCent(tripInstances[0].price) +
      roundToNearestCent(tripInstances[1].price) - 1,
      0.0001
    )

    expect(saleResponse.result.description).include(items.discount[0].debit)
  })

  lab.test("Expected price", {timeout: 10000}, async function () {
    let promotion

    try {
      // Create a promotion
      promotion = await models.Promotion.create({
        code: '',
        type: 'Promotion',
        params: {
          "description": "Bulk discount promo",
          "qualifyingCriteria": [{
            type: 'limitByCompany',
            params: {companyId: companyInstance.id},
          }],
          "discountFunction": {
            "type": "simpleRate",
            "params": {"rate": 0.67},
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

      const samplePayload = {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }],
        promoCode: {
          code: '',
          options: {},
        },
      }


      const previewResponse = await server.inject({
        method: 'POST',
        url: "/transactions/tickets/quote",
        payload: samplePayload,
        headers: {
          authorization: `Bearer ${userInstance.makeToken()}`,
        },
      })

      const expectedPrice = (
        previewResponse.result.transactionItems.find(ti => ti.itemType === 'payment').debit
      ).toFixed(2)

      const nonExpectedPrice = (
        parseFloat(previewResponse.result.transactionItems.find(ti => ti.itemType === 'payment')
          .debit) + 0.01
      ).toFixed(2)

      const failResponse = await server.inject({
        method: 'POST',
        url: "/transactions/tickets/payment",
        payload: {
          ...samplePayload,
          expectedPrice: nonExpectedPrice,
          stripeToken: await createStripeToken(),
        },
        headers: {
          authorization: `Bearer ${userInstance.makeToken()}`,
        },
      })
      expect(failResponse.statusCode).equal(400)

      const saleResponse = await server.inject({
        method: 'POST',
        url: "/transactions/tickets/payment",
        payload: {
          ...samplePayload,
          expectedPrice: expectedPrice,
          stripeToken: await createStripeToken(),
        },
        headers: {
          authorization: `Bearer ${userInstance.makeToken()}`,
        },
      })
      expect(saleResponse.statusCode).equal(200)
    } finally {
      if (promotion) await promotion.destroy()
    }
  })

  lab.test("Tickets paid with route credits not considered for promo", {timeout: 10000}, async function () {
    await cleanlyDeletePromotions({code: ''})
    await models.Promotion.create({
      code: '',
      type: 'Promotion',
      params: {
        "description": "Bulk discount promo",
        "qualifyingCriteria": [{
          type: 'limitByMinTicketCount',
          params: {n: 2},
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.50},
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
    await routeInstance.update({ tags: ['rp-1337'] })
    await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: 'rp-1337',
      },
      headers: authHeaders.admin,
    })

    const samplePayload = {
      trips: [{
        tripId: tripInstances[0].id,
        boardStopId: tripInstances[0].tripStops[0].id,
        alightStopId: tripInstances[0].tripStops[4].id,
      }, {
        tripId: tripInstances[1].id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[4].id,
      }],
      promoCode: {
        code: '',
        options: {},
      },
    }
    const saleResponse = await server.inject({
      method: 'POST',
      url: "/transactions/tickets/payment",
      payload: {
        ...samplePayload,
        applyRoutePass: true,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${userInstance.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).equal(200)
    expect(saleResponse.result.transactionItems.filter(i => i.itemType === 'discount')).length(0)

    await cleanlyDeletePromotions({code: ''})
    await models.RoutePass.destroy({ where: { tag: 'rp-1337' } })
  })
})
