import Lab from 'lab'
import server from '../src/index.js'
import {expect} from 'code'

import {randomString} from './test_common'
import {createUsersCompaniesRoutesAndTrips} from './test_data'

export const lab = Lab.script()
const {models} = require('../src/lib/core/dbschema')()

lab.experiment("Zero dollar transactions", function () {
  var authHeaders = {}
  var userInstance, routeInstance, tripInstances
  var promotionInstance

  lab.before({timeout: 15000}, async () => {
    ({userInstance, routeInstance, tripInstances} =
        await createUsersCompaniesRoutesAndTrips(models))

    var userToken = userInstance.makeToken()
    authHeaders.user = {authorization: "Bearer " + userToken}

    promotionInstance = await models.Promotion.create({
      code: randomString(),
      type: 'Promotion',
      params: {
        discountFunction: {
          type: 'simpleRate',
          params: { rate: 0.99 }
        },
        refundFunction: { type: 'refundDiscountedAmt'},
        qualifyingCriteria: [
          {type: 'limitByRoute', params: {routeIds: [routeInstance.id]}},
        ],
        usageLimit: {
          userLimit: null,
          globalLimit: null
        }
      }
    })
  })

  lab.test("Highly discounted transactions don't require payment", async () => {
    const previewResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
        }],
        promoCode: {
          code: promotionInstance.code
        },
      },
      headers: authHeaders.user
    })
    expect(previewResponse.statusCode).equal(200)
    expect(previewResponse.result.transactionItems.find(ti => ti.itemType === 'payment').debit === '0.00')

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
        }],
        promoCode: {
          code: promotionInstance.code
        },
        stripeToken: "Token is not necessary"
      },
      headers: authHeaders.user
    })

    expect(saleResponse.statusCode).equal(200)
    expect(saleResponse.result.transactionItems.find(ti => ti.itemType === 'payment').debit === '0.00')

    const tickets = await models.Ticket.findAll({
      where: {
        userId: userInstance.id,
        boardStopId: tripInstances[0].tripStops[0].id,
        status: 'valid'
      }
    })
    expect(tickets.length).equal(1)
  })
})
