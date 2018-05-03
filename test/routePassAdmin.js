/* eslint no-await-in-loop: 0 */

const {models: m} = require('../src/lib/core/dbschema')()
const {
  resetTripInstances, loginAs,
  randomEmail, randomString,
} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import Joi from 'joi'
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips, companies} from './test_data'

export const lab = Lab.script()

lab.experiment("Route pass administration", function () {
  let userInstance
  let companyInstance
  let routeInstance
  let authHeaders = {}
  let testTag
  const ticketPrice = '5.00'
  const ticketsBought = 5
  let itemInsts = []
  let trips

  lab.before({timeout: 15000}, async function () {
    testTag = `rp-${Date.now()}`;

    ({userInstance, companyInstance, routeInstance, tripInstances: trips} =
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

  lab.test("Test endpoint for GET route credits with specified user", {timeout: 15000}, async () => {
    const userId = userInstance.id
    const tag = randomString()
    const tag2 = randomString()

    // $5 credit...
    const pass = await m.RoutePass.create({
      companyId: companyInstance.id,
      userId,
      tag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: pass.id,
      debit: -ticketPrice,
    })

    let anotherCompany = await m.TransportCompany.create(companies[0])
    const pass2 = await m.RoutePass.create({
      companyId: anotherCompany.id,
      userId,
      tag: tag2,
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    const routePassPurchaseItem2 = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: pass2.id,
      debit: -ticketPrice,
    })

    const companyId = companyInstance.id
    const companyId2 = anotherCompany.id

    const noAuthResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/route_passes/all/users/${userId}`,
    })

    const wrongAuthResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/route_passes/all/users/${userId}`,
      headers: {authorization: _.get(authHeaders, 'user.authorization') + "blaer231"},
    })

    const userResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/route_passes/all/users/${userId}`,
      headers: authHeaders.user,
    })

    const adminResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/route_passes/all/users/${userId}`,
      headers: authHeaders.admin,
    })

    const adminNotAllowedResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId2}/route_passes/all/users/${userId}`,
      headers: authHeaders.admin,
    })

    const superAdminResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/route_passes/all/users/${userId}`,
      headers: authHeaders.super,
    })

    expect(noAuthResponse.statusCode).to.equal(403)
    expect(wrongAuthResponse.statusCode).to.equal(403)
    expect(userResponse.statusCode).to.equal(403)
    expect(adminNotAllowedResponse.statusCode).equal(403)

    expect(adminResponse.statusCode).to.equal(200)
    expect(superAdminResponse.statusCode).to.equal(200)

    const adminResult = adminResponse.result
    const superAdminResult = superAdminResponse.result

    const adminJoiResult = Joi.validate(adminResult.dataValues,
      Joi.array().items(Joi.object({
        tag: Joi.string(),
        balance: Joi.string(),
      }))
    )

    expect(adminJoiResult.error).null()

    const superAdminJoiResult = Joi.validate(superAdminResult.dataValues,
      Joi.array().items(Joi.object({
        tag: Joi.string(),
        balance: Joi.string(),
      }))
    )

    expect(superAdminJoiResult.error).null()

    expect(adminResult.length).equal(1)
    expect(adminResult[0].tag).equal(tag)
    expect(adminResult[0].balance).equal(1)
    expect(superAdminResult.length).equal(1)
    expect(superAdminResult[0].tag).equal(tag)
    expect(superAdminResult[0].balance).equal(1)

    await routePassPurchaseItem.destroy()
    await routePassPurchaseItem2.destroy()
  })

  lab.test("Test endpoint for GET current user's route credits", {timeout: 10000}, async () => {
    const userId = userInstance.id
    let userInst = await m.User.create({telephone: randomEmail()})

    const tags = ["asjf4546", "efsdk39", "jasdfk129"]

    // $5 credit...
    await Promise.all(tags.map(tag => m.RoutePass.create({
      companyId: companyInstance.id,
      userId,
      tag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })))

    // Clear credits for 2nd user instance
    await m.RoutePass.destroy({
      where: {userId: userInst.id},
    })

    const noAuthResponse = await server.inject({
      method: "GET",
      url: "/route_passes",
    })

    const wrongAuthResponse = await server.inject({
      method: "GET",
      url: "/route_passes",
      headers: {authorization: _.get(authHeaders, 'user.authorization') + "xy21"},
    })

    const successNoCreditsResponse = await server.inject({
      method: "GET",
      url: "/route_passes",
      headers: {
        authorization: `Bearer ${userInst.makeToken()}`,
      },
    })

    const successResponse = await server.inject({
      method: "GET",
      url: "/route_passes",
      headers: authHeaders.user,
    })

    const successExpiriesResponse = await server.inject({
      method: "GET",
      url: "/route_passes/expiries",
      headers: authHeaders.user,
    })

    expect(noAuthResponse.statusCode).to.equal(403)
    expect(wrongAuthResponse.statusCode).to.equal(403)

    expect(successNoCreditsResponse.statusCode).to.equal(200)
    expect(successResponse.statusCode).to.equal(200)

    expect(successNoCreditsResponse.result).to.be.empty()
    expect(successResponse.result).to.not.be.empty()

    expect(successResponse.result).to.only.include(tags)
    expect(successResponse.result[tags[0]]).to.equal(1)
    expect(successResponse.result[tags[1]]).to.equal(1)
    expect(successResponse.result[tags[2]]).to.equal(1)

    expect(successExpiriesResponse.result).to.only.include(tags)
    expect(Object.values(successExpiriesResponse.result[tags[0]])[0]).to.equal(1)
    expect(Object.values(successExpiriesResponse.result[tags[1]])[0]).to.equal(1)
    expect(Object.values(successExpiriesResponse.result[tags[2]])[0]).to.equal(1)
  })

  lab.test('Route passes can be expired', {timeout: 20000}, async function () {
    const [userId, companyId, tag] = [userInstance.id, companyInstance.id, testTag]

    // Create the credit
    const routePassInst = await m.RoutePass.create({userId, companyId, tag, status: 'valid', notes: {price: +ticketPrice}})

    const routePassPurchaseItem = await m.TransactionItem.create({
      itemType: 'routePass',
      itemId: routePassInst.id,
      debit: -ticketPrice,
    })

    const expireResponse = await server.inject({
      method: 'POST',
      url: `/companies/${companyInstance.id}/route_passes/${tag}/users/${userId}/${routePassInst.id}/expire`,
      headers: authHeaders.admin,
    })
    expect(expireResponse.result.status).equal('expired')

    const ti = await m.TransactionItem.find({ where: { itemType: 'routePass', itemId: routePassInst.id } })
    expect(ti.debit).equal(ticketPrice)

    await routePassInst.destroy()
    await routePassPurchaseItem.destroy()
  })


  lab.test('Multiple route passes can be expired', {timeout: 20000}, async function () {
    const [userId, companyId, tag] = [userInstance.id, companyInstance.id, testTag]

    // Create the credit
    const routePassInst = await m.RoutePass.create({userId, companyId, tag, status: 'valid', notes: {price: +ticketPrice}})
    const routePassInst2 = await m.RoutePass.create({userId, companyId, tag, status: 'valid', notes: {price: +ticketPrice}})
    const routePassInst3 = await m.RoutePass.create({userId, companyId, tag, status: 'valid', notes: {price: +ticketPrice}})

    const routePassPurchaseItems = await Promise.all(
      [routePassInst, routePassInst2, routePassInst3].map(
        pass => m.TransactionItem.create({
          itemType: 'routePass',
          itemId: pass.id,
          debit: -ticketPrice,
        })
      )
    )

    const expireResponse = await server.inject({
      method: 'POST',
      url: `/companies/${companyInstance.id}/route_passes/${tag}/users/${userId}/expire`,
      headers: authHeaders.admin,
      payload: { quantity: 2 },
    })
    expect(expireResponse.result.length).equal(2)
    expect(expireResponse.result[0].status).equal('expired')
    expect(expireResponse.result[1].status).equal('expired')

    const ti = await m.TransactionItem.find({ where: { itemType: 'routePass', itemId: routePassInst.id } })
    expect(ti.debit).equal(ticketPrice)

    const ti2 = await m.TransactionItem.find({ where: { itemType: 'routePass', itemId: routePassInst2.id } })
    expect(ti2.debit).equal(ticketPrice)

    await routePassInst3.reload()
    expect(routePassInst3.status).equal('valid')

    await Promise.all(routePassPurchaseItems.map(i => i.destroy()))
  })

  lab.test('Route pass history', {timeout: 30000}, async function () {
    const routePass = await m.RoutePass.create({
      companyId: companyInstance.id,
      userId: userInstance.id,
      tag: testTag,
      status: 'valid',
      notes: { price: +ticketPrice },
    })

    // Charge for the one route pass again and again
    const testDataPromises = _.range(0, 200)
      /* txn description | amount | committed */
      .map(() => [randomString(), (Math.random() * 1000 - 500).toFixed(2), Math.random() > 0.5])
      .map(async ([description, amount, committed]) =>
        m.Transaction.create({
          transactionItems: [{
            itemType: 'routePass',
            itemId: routePass.id,
            debit: amount,
          }, {
            itemType: 'account',
            itemId: (await m.Account.getByName('Upstream Route Credits')).id,
            credit: amount,
          }],
          committed,
          description,
        }, {include: [m.TransactionItem]})
      )

    const testData = await Promise.all(testDataPromises)

    // Get all the transaction item ids...
    const expectedIDs = _(testData)
      .filter(t => t.committed)
      .map(t => t.transactionItems.find(ti => ti.itemType === 'routePass').id)
      .orderBy([x => x], ['desc'])
      .value()

    // We should get a list containing the user's newly-created entry
    const creditEntriesResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_passes/${testTag}/users`,
      method: 'GET',
      headers: authHeaders.admin,
    })

    expect(creditEntriesResponse.statusCode).equal(200)
    expect(creditEntriesResponse.result).equal({[userInstance.id]: [routePass.toJSON()]})

    // We should get a list containing the user's newly-created entry
    const companyWideCreditEntriesResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_passes`,
      method: 'GET',
      headers: authHeaders.admin,
    })

    expect(companyWideCreditEntriesResponse.statusCode).equal(200)
    expect(companyWideCreditEntriesResponse.result.length).equal(1)
    expect(companyWideCreditEntriesResponse.result[0]).equal(testTag)

    // First fetch should return top twenty?
    const firstFetchResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_passes/${testTag}/users/${userInstance.id}/history`,
      method: 'GET',
      headers: authHeaders.admin,
    })

    expect(firstFetchResponse.statusCode).equal(200)
    expect(firstFetchResponse.result.length).equal(20)
    expect(firstFetchResponse.result.map(ti => ti.id)).equal(expectedIDs.slice(0, 20))

    // Next
    const nextFetchResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_passes/${testTag}/users/${userInstance.id}/history?lastId=${firstFetchResponse.result[19].id}`,
      method: 'GET',
      headers: authHeaders.admin,
    })

    expect(nextFetchResponse.statusCode).equal(200)
    expect(nextFetchResponse.result.length).equal(20)
    expect(nextFetchResponse.result.map(ti => ti.id)).equal(expectedIDs.slice(20, 40))
  })
})
