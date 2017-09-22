import Lab from 'lab'
import _ from 'lodash'
import server from '../src/index.js'
import {expect} from 'code'

import {resetTripInstances, loginAs, randomString, createStripeToken} from './test_common'
import * as promotions from '../src/lib/promotions'
import {createUsersCompaniesRoutesAndTrips} from './test_data'
import {TransactionBuilder, initBuilderWithTicketSale, updateTransactionBuilderWithPromoDiscounts} from '../src/lib/transactions/builder'

const applyPromoCode = promotions.applyPromoCode

export const lab = Lab.script()
const {db, models} = require('../src/lib/core/dbschema')()

lab.experiment("Promotion calculations", function () {
  var authHeaders = {}
  var templates = null
  var userInstance, companyInstance, routeInstance, tripInstances

  lab.before({timeout: 15000}, async () => {
    ({userInstance, companyInstance, routeInstance, tripInstances} =
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
          item: {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 0},
          price: tripInstances[0].price,
          trip: {
            ...tripInstances[0].dataValues,
            route: routeInstance,
          }
        },
        {
          item: {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 1},
          price: tripInstances[1].price,
          trip: {
            ...tripInstances[1].dataValues,
            route: routeInstance,
          }
        },
        {
          item: {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 2},
          price: tripInstances[2].price,
          trip: {
            ...tripInstances[2].dataValues,
            route: routeInstance,
          }
        }
      ],
      transactionBuilder: null, // Instantiated later
      promoParams: {
        qualifyingCriteria: [
            {type: 'limitByCompany', params: {companyId: companyInstance.id}},
            {type: 'limitByRoute', params: {routeIds: [routeInstance.id]}},
        ],
        discountFunction: {
          type: "tieredRateByTotalValue",
          params: {"schedule": [[5, 0.2]]}
        },
        refundFunction: {
          type: "refundDiscountedAmt"
        },
        usageLimit: {
          userLimit: null,
          globalLimit: null,
        }
      }
    }

    const tb = new TransactionBuilder(
      {
        db, models, dryRun: false, committed: true,
      }
    )
    tb.items = templates.items
    templates.transactionBuilder = tb
  })

  lab.afterEach(async () => resetTripInstances(models, tripInstances))

  lab.test(
    "Create a basic promotion",
    async () => {
      const calculation = promotions.createCalculation(
        'Promotion',
        templates.transactionBuilder,
        templates.promoParams,
        {},
        'description',
        1337
      )

      await calculation.initialize()

      expect(calculation.isQualified()).true()

      const [discounts, refunds] = calculation.computeDiscountsAndRefunds()

      expect(_.sumBy(templates.items, it => parseFloat(it.price))).above(5)

      expect(discounts[0]).about(tripInstances[0].price * 0.2, 0.015)
      expect(discounts[1]).about(tripInstances[1].price * 0.2, 0.015)
      expect(discounts[2]).about(tripInstances[2].price * 0.2, 0.015)

      expect(refunds[0]).about(tripInstances[0].price * 0.2, 0.015)
      expect(refunds[1]).about(tripInstances[1].price * 0.2, 0.015)
      expect(refunds[2]).about(tripInstances[2].price * 0.2, 0.015)
    }
  )

  lab.test(
    "Trips do not qualify (wrong companyId)",
    async () => {
      const promoParams = _.cloneDeep(templates.promoParams)
      promoParams.qualifyingCriteria[0].params.companyId = companyInstance.id + 1

      const calculation = promotions.createCalculation(
        'Promotion',
        templates.transactionBuilder,
        promoParams,
        {},
        'description',
        1337
      )
      await calculation.initialize()

      expect(calculation.isQualified()).false()
    }
  )
  lab.test(
    "Trips do not qualify (wrong routeId)",
    async () => {
      const promoParams = _.cloneDeep(templates.promoParams)
      promoParams.qualifyingCriteria[1].params.routeIds[0] = routeInstance.id + 1

      const calculation = promotions.createCalculation(
        'Promotion',
        templates.transactionBuilder,
        promoParams,
        {},
        'description',
        1337
      )
      await calculation.initialize()

      expect(calculation.isQualified()).false()
    }
  )
  // REPLACE WITH A TEST FOR TransactionBuilder
  lab.test('Integrate as part of a purchaseOrder', async () => {
    var promoCode = randomString()

    // Create the promo
    await models.Promotion.destroy({
      where: {code: promoCode}
    })
    await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: templates.promoParams,
      description: `Test promo ${Date.now()}`
    })

    const poItems = templates.items.map(it => it.item)
    let transactionBuilder = await initBuilderWithTicketSale(templates.connection, poItems)

    transactionBuilder = await applyPromoCode(
      transactionBuilder,
      {
        code: promoCode,
        options: null
      },
      'Promotion'
    )

    updateTransactionBuilderWithPromoDiscounts(transactionBuilder, { code: promoCode })

    const items = transactionBuilder.items
    const discountItem = transactionBuilder.transactionItemsByType.discount[0]

    for (let item of items) {
      expect(item.ticket.notes.discountValue).about(item.price * 0.2, 0.015)
      expect(discountItem.discount.discountAmounts[item.ticket.id])
        .about(item.price * 0.2, 0.015)
      expect(item.transactionItem.notes.outstanding)
        .about(item.price * 0.8, 0.015)
    }

    expect(discountItem.discount.code).equal(promoCode)
    expect(discountItem.discount.userOptions).not.exist()
    expect(typeof discountItem.discount.description).equal('string')
    expect(discountItem.discount).include(['description', 'userOptions'])
  })

  lab.test('Bad promoCode', async () => {
    const poItems = templates.items.map(it => it.item)
    poItems.forEach(function (e) {
      delete e.userId
    })

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        promoCode: { code: 'BADCODE', options: {} },
      },
      headers: authHeaders.user,
    })

    expect(saleResponse.statusCode).to.equal(400)
  })
})
