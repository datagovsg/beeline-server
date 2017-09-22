/* eslint no-await-in-loop: 0 */

const {db, models: m} = require('../src/lib/core/dbschema')()
const {
  resetTripInstances, loginAs,
  randomEmail, randomString,
} = require("./test_common")
import {expect, fail} from "code"
import server from "../src/index"
import Lab from "lab"
import Joi from 'joi'
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips, companies} from './test_data'

export var lab = Lab.script()

lab.experiment("Legacy Route-specific Credits", function () {
  var userInstance, companyInstance, routeInstance
  var authHeaders = {}
  var testTag
  const ticketPrice = '5.00'
  const ticketsBought = 5
  let itemInsts = []
  var trips

  lab.before({timeout: 15000}, async function () {
    testTag = `rp-${Date.now()}`;

    ({userInstance, companyInstance, routeInstance, tripInstances: trips} =
        await createUsersCompaniesRoutesAndTrips(m, new Array(ticketsBought).fill(+ticketPrice)))

    await routeInstance.update({
      tags: [testTag]
    })

    trips.forEach((trip, i) => {
      itemInsts.push({
        item: {
          tripId: trip.id,
          boardStopId: trip.tripStops[0].id,
          alightStopId: trip.tripStops[2].id,
          userId: userInstance.id
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
      permissions: ['refund', 'manage-routes']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    var superToken = (await loginAs('superadmin')).result.sessionToken
    authHeaders.super = { authorization: 'Bearer ' + superToken }
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get "user already has ticket" errors, or unexpected
    capacity errors
  */
  lab.beforeEach(async function () {
    await resetTripInstances(m, trips)
    await m.RouteCredit.destroy({
      where: {userId: userInstance.id}
    })
  })

  lab.test('Adding/subtracting of credits', {timeout: 20000}, async function () {
    var userInst = await m.User.create({telephone: randomEmail()})
    var userId = userInst.id
    var companyId = companyInstance.id

    // Test within a transaction
    await db.transaction(async (t) => {
      var initialCredit = await m.RouteCredit.getUserCredits(
        userInst.id, companyId, testTag, {transaction: t})

      expect(initialCredit).equal('0.00')

      // When it is empty
      await m.RouteCredit.addUserCredits(
        userId, companyId, testTag, '3.00',
        {transaction: t}
      )

      expect(await m.RouteCredit.getUserCredits(
        userInst.id, companyId, testTag,
        {transaction: t})
      ).equal('3.00')

      await m.RouteCredit.addUserCredits(userInst.id, companyId, testTag, '1.50', {transaction: t})

      expect(await m.RouteCredit.getUserCredits(userInst.id, companyId, testTag, {transaction: t}))
        .equal('4.50')

      await m.RouteCredit.subtractUserCredits(userInst.id, companyId, testTag, '2.00', {transaction: t})

      expect(await m.RouteCredit.getUserCredits(userInst.id, companyId, testTag, {transaction: t}))
        .equal('2.50')

      // Test a different tag...
      expect(await m.RouteCredit.getUserCredits(userInst.id, companyId, 'SomeOtherTag', {transaction: t}))
        .equal('0.00')

      try {
        await m.RouteCredit.subtractUserCredits(userInst.id, companyId, testTag, '2.51', {transaction: t})
        fail("Should not be reached")
      } catch (err) {
        expect(err.message).not.equal("Should not be reached")
      }

      try {
        await m.RouteCredit.addUserCredits(userInst.id, companyId, testTag, '-2.51', {transaction: t})
        fail("Should not be reached")
      } catch (err) {
        expect(err.message).not.equal("Should not be reached")
      }

      expect(await m.RouteCredit.getUserCredits(userInst.id, companyId, testTag, {transaction: t}))
        .equal('2.50')

      // Don't commit -- check that the transaction is actually rolled back.
      throw new Error("BlahBlah") // eslint-disable-line handle-callback-err
    })
      .catch((err) => {
        if (err.message !== 'BlahBlah') {
          throw err
        }
      })

    // Transaction has been rolled back, credits = 0
    expect(await m.RouteCredit.getUserCredits(userInst.id, companyId, testTag))
      .equal('0.00')
  })

  lab.test("Test endpoint for GET route credits with specified user", {timeout: 15000}, async () => {
    const userId = userInstance.id
    const tag = randomString()
    const tag2 = randomString()

    // $5 credit...
    await m.RouteCredit.create({
      companyId: companyInstance.id,
      userId,
      tag,
      balance: '5.00'
    })

    let anotherCompany = await m.TransportCompany.create(companies[0])
    await m.RouteCredit.create({
      companyId: anotherCompany.id,
      userId,
      tag: tag2,
      balance: '10.00'
    })

    const companyId = companyInstance.id
    const companyId2 = anotherCompany.id

    const noAuthResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/routeCreditsByUser/${userId}`,
    })

    const wrongAuthResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/routeCreditsByUser/${userId}`,
      headers: {authorization: _.get(authHeaders, 'user.authorization') + "blaer231"}
    })

    const userResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/routeCreditsByUser/${userId}`,
      headers: authHeaders.user
    })

    const adminResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/routeCreditsByUser/${userId}`,
      headers: authHeaders.admin
    })

    const adminNotAllowedResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId2}/routeCreditsByUser/${userId}`,
      headers: authHeaders.admin
    })

    const superAdminResponse = await server.inject({
      method: "GET",
      url: `/companies/${companyId}/routeCreditsByUser/${userId}`,
      headers: authHeaders.super
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
        balance: Joi.string()
      }))
    )

    expect(adminJoiResult.error).null()

    const superAdminJoiResult = Joi.validate(superAdminResult.dataValues,
      Joi.array().items(Joi.object({
        tag: Joi.string(),
        balance: Joi.string()
      }))
    )

    expect(superAdminJoiResult.error).null()

    expect(adminResult.length).equal(1)
    expect(adminResult[0].tag).equal(tag)
    expect(adminResult[0].balance).equal("5.00")
    expect(superAdminResult.length).equal(1)
    expect(superAdminResult[0].tag).equal(tag)
    expect(superAdminResult[0].balance).equal("5.00")
  })

  lab.test("Test endpoint for GET current user's route credits", {timeout: 10000}, async () => {
    const userId = userInstance.id
    var userInst = await m.User.create({telephone: randomEmail()})

    const tag1 = "asjf4546"
    const tag2 = "efsdk39"
    const tag3 = "jasdfk129"

    // $5 credit...
    await m.RouteCredit.bulkCreate([
      { userId, tag: tag1, balance: '5.00', companyId: companyInstance.id},
      { userId, tag: tag2, balance: '5.00', companyId: companyInstance.id},
      { userId, tag: tag3, balance: '5.00', companyId: companyInstance.id}
    ])

    // Clear credits for 2nd user instance
    await m.RouteCredit.destroy({
      where: {userId: userInst.id}
    })

    const noAuthResponse = await server.inject({
      method: "GET",
      url: "/routeCredits"
    })

    const wrongAuthResponse = await server.inject({
      method: "GET",
      url: "/routeCredits",
      headers: {authorization: _.get(authHeaders, 'user.authorization') + "xy21"}
    })

    const successNoCreditsResponse = await server.inject({
      method: "GET",
      url: "/routeCredits",
      headers: {
        authorization: `Bearer ${userInst.makeToken()}`
      }
    })

    const successResponse = await server.inject({
      method: "GET",
      url: "/routeCredits",
      headers: authHeaders.user
    })

    expect(noAuthResponse.statusCode).to.equal(403)
    expect(wrongAuthResponse.statusCode).to.equal(403)

    expect(successNoCreditsResponse.statusCode).to.equal(200)
    expect(successResponse.statusCode).to.equal(200)

    expect(successNoCreditsResponse.result).to.be.empty()
    expect(successResponse.result).to.not.be.empty()

    expect(successResponse.result).to.only.include([
      tag1, tag2, tag3
    ])
    expect(successResponse.result[tag1]).to.equal("5.00")
    expect(successResponse.result[tag2]).to.equal("5.00")
    expect(successResponse.result[tag3]).to.equal("5.00")
  })

  lab.test('Credits can be expired', {timeout: 20000}, async function () {
    var userId = userInstance.id

    // Create the credit
    await m.RouteCredit.addUserCredits(userId, companyInstance.id, testTag, 15.43)

    // Expire the same credit
    const expireTooMuchResponse = await server.inject({
      method: 'POST',
      url: `/companies/${companyInstance.id}/route_credits/${testTag}/users/${userId}/expire`,
      payload: {
        amount: 17.05
      },
      headers: authHeaders.admin,
    })
    expect(expireTooMuchResponse.statusCode).equal(400)

    const expireResponse = await server.inject({
      method: 'POST',
      url: `/companies/${companyInstance.id}/route_credits/${testTag}/users/${userId}/expire`,
      payload: {
        amount: 7.05
      },
      headers: authHeaders.admin,
    })
    expect(expireResponse.statusCode).equal(200)
    const expireTransaction = expireResponse.result
    const expireTransactionInstance = await m.Transaction.findById(expireResponse.result.id, {
      include: [m.TransactionItem]
    })

    // Check the transaction
    expect(expireTransactionInstance.transactionItems.length).equal(2)
    expect(expireTransaction.transactionItems.length).equal(2)
    expect(expireTransaction.description).startWith('Manually expire route credits in ')

    expect(expireTransaction.transactionItems
      .find(ti => ti.itemType === 'routeCredits')
      .debit
    ).equal('7.05')

    expect(expireTransaction.transactionItems
      .find(ti => ti.itemType === 'account')
      .credit
    ).equal('7.05')
    expect((await m.Account.findById(expireTransaction.transactionItems
      .find(ti => ti.itemType === 'account')
      .itemId
    )).name).equal('Upstream Route Credits')
    expect((await m.RouteCredit.getUserCredits(userId, companyInstance.id, testTag)))
      .equal('8.38')
  })

  lab.test('Route credit history', {timeout: 30000}, async function () {
    const routeCredit = await m.RouteCredit.create({
      companyId: companyInstance.id,
      userId: userInstance.id,
      tag: testTag,
      balance: '5.00'
    })

    const testDataPromises = _.range(0, 200)
      /* txn description | amount | committed */
      .map(() => [randomString(), (Math.random() * 1000 - 500).toFixed(2), Math.random() > 0.5])
      .map(async ([description, amount, committed]) =>
        m.Transaction.create({
          transactionItems: [{
            itemType: 'routeCredits',
            itemId: routeCredit.id,
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
      .map(t => t.transactionItems.find(ti => ti.itemType === 'routeCredits').id)
      .orderBy([x => x], ['desc'])
      .value()

    // We should get a list containing the user's newly-created entry
    const creditEntriesResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_credits/${testTag}/users`,
      method: 'GET',
      headers: authHeaders.admin
    })

    expect(creditEntriesResponse.statusCode).equal(200)
    expect(creditEntriesResponse.result.length).equal(1)
    expect(creditEntriesResponse.result[0]).equal(routeCredit.toJSON())

    // We should get a list containing the user's newly-created entry
    const companyWideCreditEntriesResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_credits`,
      method: 'GET',
      headers: authHeaders.admin
    })

    expect(companyWideCreditEntriesResponse.statusCode).equal(200)
    expect(companyWideCreditEntriesResponse.result.length).equal(1)
    expect(companyWideCreditEntriesResponse.result[0]).equal(testTag)

    // First fetch should return top twenty?
    const firstFetchResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_credits/${testTag}/users/${userInstance.id}/history`,
      method: 'GET',
      headers: authHeaders.admin
    })

    expect(firstFetchResponse.statusCode).equal(200)
    expect(firstFetchResponse.result.length).equal(20)
    expect(firstFetchResponse.result.map(ti => ti.id)).equal(expectedIDs.slice(0, 20))

    // Next
    const nextFetchResponse = await server.inject({
      url: `/companies/${companyInstance.id}/route_credits/${testTag}/users/${userInstance.id}/history?lastId=${firstFetchResponse.result[19].id}`,
      method: 'GET',
      headers: authHeaders.admin
    })

    expect(nextFetchResponse.statusCode).equal(200)
    expect(nextFetchResponse.result.length).equal(20)
    expect(nextFetchResponse.result.map(ti => ti.id)).equal(expectedIDs.slice(20, 40))
  })
})
