const {models: m} = require('../src/lib/core/dbschema')()
const {resetTripInstances, randomString} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import {createUsersCompaniesRoutesAndTrips} from './test_data'

export var lab = Lab.script()

lab.experiment("Route-specific Credits", function () {
  var userInstance, routeInstance
  var testTag
  const ticketPrice = '5.00'
  const ticketsBought = 5
  const smallPassSize = 5
  var trips

  lab.before({timeout: 15000}, async function () {
    testTag = `test-${Date.now()}`;

    ({userInstance, routeInstance, tripInstances: trips} =
        await createUsersCompaniesRoutesAndTrips(m, new Array(ticketsBought).fill(+ticketPrice)))

    await routeInstance.update({
      tags: [testTag]
    })
  })

  lab.beforeEach(async function () {
    await resetTripInstances(m, trips)
    await m.RoutePass.destroy({
      where: {userId: userInstance.id}
    })
    await m.Promotion.destroy({
      where: { code: '' }
    })
  })

  lab.test('Pricing for single ticket and no passes', {timeout: 20000}, async function () {
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
  })

  lab.test('Pricing for single ticket and 1 pass size with no promo', {timeout: 20000}, async function () {
    await routeInstance.update({
      notes: { passSizes: [smallPassSize] },
      tags: ['rp-111']
    })
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
    expect(response.result[smallPassSize].price)
      .about(smallPassSize * parseFloat(ticketPrice), 0.001)
  })

  lab.test('Pricing for single ticket and 2 pass sizes with default promo', {timeout: 20000}, async function () {
    await routeInstance.update({
      notes: { passSizes: [smallPassSize, 10] },
      tags: ['rp-111']
    })
    await m.Promotion.destroy({
      where: { code: '' }
    })
    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'rp-111',
        "qualifyingCriteria": [{
          "type": "noLimit"
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.2}
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
    expect(response.result['5'].price).equal(20)
    expect(response.result['5'].discount).equal(5)
    expect(response.result['10'].price).equal(40)
    expect(response.result['10'].discount).equal(10)
  })

  lab.test('Pricing for single ticket and 2 pass sizes with default promo with diff tag', {timeout: 20000}, async function () {
    await routeInstance.update({
      notes: { passSizes: [smallPassSize, 10] },
      tags: ['rp-' + randomString(), 'asdf']
    })
    await m.Promotion.destroy({
      where: { code: '' }
    })
    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'asdf',
        "qualifyingCriteria": [{
          "type": "noLimit"
        }],
        "discountFunction": {
          "params": {"schedule": [[25, 5], [50, 10]]},
          "type": "tieredFixedByTotalValue"
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
    expect(response.result['5'].price).equal(20)
    expect(response.result['5'].discount).equal(5)
    expect(response.result['10'].price).equal(40)
    expect(response.result['10'].discount).equal(10)
  })

  lab.test('Pricing for single ticket and 2 pass sizes with 2 default promos', {timeout: 20000}, async function () {
    await routeInstance.update({
      notes: { passSizes: [smallPassSize, 10] },
      tags: ['rp-111']
    })
    await m.Promotion.destroy({
      where: { code: '' }
    })
    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'rp-111',
        "qualifyingCriteria": [{
          "type": "noLimit"
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.1}
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })

    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'rp-111',
        "qualifyingCriteria": [{
          "type": "noLimit"
        }],
        "discountFunction": {
          "type": "tieredRateByTotalValue",
          "params": {
            "schedule": [
              [25, 0.2],
              [50, 0.4]
            ]
          }
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
    expect(response.result['5'].price).equal(20)
    expect(response.result['5'].discount).equal(5)
    expect(response.result['10'].price).equal(30)
    expect(response.result['10'].discount).equal(20)
  })

  lab.test('Pricing for single ticket and 2 pass sizes with 2 default promos for special customer', {timeout: 20000}, async function () {
    await routeInstance.update({
      notes: { passSizes: [smallPassSize, 10] },
      tags: ['rp-111']
    })
    await m.Promotion.destroy({
      where: { code: '' }
    })
    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'rp-111',
        "qualifyingCriteria": [{
          "type": "noLimit"
        }],
        "discountFunction": {
          "type": "simpleRate",
          "params": {"rate": 0.1}
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })

    const contactListInstance = await m.ContactList.create({
      transportCompanyId: routeInstance.transportCompanyId,
      telephones: [userInstance.telephone],
      emails: []
    })

    await m.Promotion.create({
      code: '',
      type: 'RoutePass',
      params: {
        "description": "For test",
        "tag": 'rp-111',
        "qualifyingCriteria": [{
          "type": "limitByContactList",
          "params": { "contactListId": contactListInstance.id }
        }],
        "discountFunction": {
          "type": "tieredRateByTotalValue",
          "params": {
            "schedule": [
              [25, 0.2],
              [50, 0.4]
            ]
          }
        },
        "refundFunction": {
          "type": "refundDiscountedAmt"
        },
        "usageLimit": {
          "userLimit": null,
          "globalLimit": null
        }
      }
    })
    let response = await server.inject({
      method: "GET",
      url: `/routes/${routeInstance.id}/price_schedule`,
      headers: {
        authorization: 'Bearer ' + userInstance.makeToken(),
      },
    })

    expect(response.statusCode).equal(200)
    expect(response.result['1'].price).equal(+ticketPrice)
    expect(response.result['5'].price).equal(20)
    expect(response.result['5'].discount).equal(5)
    expect(response.result['10'].price).equal(30)
    expect(response.result['10'].discount).equal(20)
  })
})
