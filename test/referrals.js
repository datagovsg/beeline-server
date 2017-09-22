const {db, models: m} = require('../src/lib/core/dbschema')()
const {loginAs, createStripeToken} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips, destroyUsersCompaniesRoutesAndTrips} from './test_data'

export var lab = Lab.script()

// Used to create a new user in db, together with its
// corresponding refCode and Credits entry
async function createUserWithRefCode () {
  var user = {}

  var userInst = await m.User.create({
    email: `testuser${new Date().getTime()}@example.com`,
    name: "Test user",
    telephone: Date.now(),
  })
  user.userInst = userInst

  var userToken = userInst.makeToken()
  user.authHeader = {authorization: "Bearer " + userToken}

  var refCode = (await server.inject({
    method: "GET",
    url: "/user/referralCode",
    headers: user.authHeader
  })).result

  var refCodeInst = await m.Promotion.find({
    where: {code: refCode}
  })

  user.refCodeInst = refCodeInst

  var [creditInst] = await m.Credit.findCreateFind({
    defaults: {userId: userInst.id, balance: 0.0},
    where: {userId: userInst.id}
  })

  user.creditInst = creditInst

  return user
}


lab.experiment("Referrals", function () {
  var userInstance, companyInstance, routeInstance, stopInstances, tripInstances
  var templates
  var authHeaders = {}

  var existingUser, existingUser2, newUser

  lab.beforeEach({timeout: 15000}, async function () {
    ({userInstance, companyInstance, routeInstance, tripInstances, stopInstances} =
      await createUsersCompaniesRoutesAndTrips(m))

    var userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    newUser = {
      userInst: userInstance,
      authHeader: authHeaders.user,
      refCodeInst: null
    }

    existingUser = await createUserWithRefCode()
    existingUser2 = await createUserWithRefCode()

    var adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    templates = {
      connection: {
        db, models: m, dryRun: false, committed: true,
        promoCode: {code: existingUser.refCodeInst.code, options: null},
        transaction: null
      },
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
          trip: tripInstances[0]
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
          trip: tripInstances[1]
        }],
      items2: [
        {
          item: {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 2},
          price: tripInstances[2].price,
          trip: tripInstances[2]
        }
      ],
    }

    // Double check conditions
    // existingUsers' refCode Params link back correctly
    expect(existingUser.refCodeInst.params.ownerId).equal(existingUser.userInst.id)
    expect(existingUser2.refCodeInst.params.ownerId).equal(existingUser2.userInst.id)

    // existingUsers' have 0.00 balance in their credit entries
    expect(existingUser.creditInst.balance).equal('0.00')
    expect(existingUser2.creditInst.balance).equal('0.00')
  })

  lab.after({timeout: 10000}, destroyUsersCompaniesRoutesAndTrips(m, userInstance, companyInstance, tripInstances, stopInstances, routeInstance))

  lab.test('[GET] /user/referralCode does not work if user is not logged in', {timeout: 10000}, async function () {
    // Send request to route with no authHeader (ie. not logged in)
    var response1 = await server.inject({
      method: "GET",
      url: "/user/referralCode",
    })

    expect(response1.statusCode).equal(403)
  })

  // Test on [GET]/user/referralCode route, which handles creation and retrieval of referral codes. [/endpoints/users.js]
  // Tests:
  // 1: Referral Code is created upon request by a logged in user, if user does not yet have a referral code
  // 2: Referral Code is returned if user did not have a referral code initially
  // 3: Referral Code is returned if user already has a referral code
  lab.test('Referral Code Creation and Retrieval', {timeout: 10000}, async function () {
    // 1: Referral Code is created upon request by a logged in user, if user does not yet have a referral code

    expect(userInstance.refCodeId).null() // New user does not have a refCode assigned

    var response2 = await server.inject({ // Send request to route with authHeader (ie. logged in)
      method: "GET",
      url: "/user/referralCode",
      headers: authHeaders.user
    })

    expect(response2.statusCode).equal(200)

    await userInstance.reload()
    expect(userInstance.refCodeId).not.null()

    var refCodeInstance = await m.Promotion.findById(userInstance.refCodeId)
    expect(refCodeInstance).exist()

    // TODO: Verify Schema

    // 2: Referral Code is returned if user did not have a referral code initially

    expect(response2.result).equal(refCodeInstance.code)

    // 3: Referral Code is returned if user already has a referral code

    var response3 = await server.inject({ // Send request to route with authHeader (ie. logged in)
      method: "GET",
      url: "/user/referralCode",
      headers: authHeaders.user
    })

    expect(response3.statusCode).equal(200)

    expect(response3.result).equal(response2.result)
    expect((await m.Promotion.findAll({where: {code: refCodeInstance.code}})).length).equal(1)
  })

  // Tests distribution of referral benefits via POST /user/applyRefCode
  // 1. Credits are not given out if a bad refCode is given
  // 2. newUser is given referral credits on giving valid refCode
  // 3. existingUser is given general credits on newUser completing purchase
  // 4. Repeated usage of a valid refCode does not work
  lab.test('Distribution of benefits via endpoint /user/applyRefCode', {timeout: 10000}, async function () {
    console.log("Using users: ", newUser.userInst.id, existingUser.userInst.id)
    expect((await newUser.userInst.isEligibleForReferralProgram())).true()

    // Establish that newUser has no referral credits at the start
    expect(await m.ReferralCredit.getReferralCredits(newUser.userInst.id)).equal('0.00')

    // Establish that existingUser has no general credits at the start
    expect(await m.Credit.getUserCredits(existingUser.userInst.id)).equal('0.00')

    // error is returned if a bad referral code is given
    let badRefCodeResp = await server.inject({
      method: "POST",
      url: "/user/applyRefCode",
      headers: newUser.authHeader,
      payload: {
        refCode: "BADREFCODE",
      }
    })

    expect(badRefCodeResp.statusCode).equal(400)

    let refereeReward = process.env.REFERRAL_REFEREE_REWARD || '0.00'
    let referrerReward = process.env.REFERRAL_REFERER_REWARD || '0.00'

    // apply the ref code correctly
    let applyRefCodeResp = await server.inject({
      method: "POST",
      url: "/user/applyRefCode",
      headers: newUser.authHeader,
      payload: {
        refCode: existingUser.refCodeInst.code,
      }
    })

    expect(applyRefCodeResp.statusCode).equal(200)

    await newUser.userInst.reload()

    expect(newUser.userInst.referrerId).equal(existingUser.userInst.id)
    expect(newUser.userInst.notes).exist()
    expect(newUser.userInst.notes.pendingPayoutToReferrer).true()

    let referralCredits = await m.ReferralCredit.getReferralCredits(newUser.userInst.id)
    let generalCredits = await m.Credit.getUserCredits(existingUser.userInst.id)

    // Benefits were given out
    expect(referralCredits).equal(refereeReward)
    expect(generalCredits).equal('0.00')

    // applying the ref code again does not give benefits again
    let applyRefCodeTwiceResp = await server.inject({
      method: "POST",
      url: "/user/applyRefCode",
      headers: newUser.authHeader,
      payload: {
        refCode: existingUser.refCodeInst.code,
      }
    })

    expect(applyRefCodeTwiceResp.statusCode).equal(400)

    referralCredits = await m.ReferralCredit.getReferralCredits(newUser.userInst.id)
    generalCredits = await m.Credit.getUserCredits(existingUser.userInst.id)
    expect(newUser.userInst.notes).exist()
    expect(newUser.userInst.notes.pendingPayoutToReferrer).true()
    expect(newUser.userInst.referrerId).equal(existingUser.userInst.id)

    // No credits were given out after repeated request
    expect(referralCredits).equal(refereeReward)
    expect(generalCredits).equal('0.00')

    // complete first purchase
    let poItems = templates.items.map(it => it.item)
    poItems.forEach(function (e) {
      delete e.userId
    })

    let purchaseResp = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: poItems,
        stripeToken: await createStripeToken(),
        applyReferralCredits: true,
      },
      headers: newUser.authHeader
    })

    expect(purchaseResp.statusCode).equal(200)

    let totalPrice = _.sum(templates.items.map(it => parseFloat(it.price)))
    let remainingReferralCredit = parseFloat(await m.ReferralCredit.getReferralCredits(newUser.userInst.id))
    let expectedReferralCreditsUsed = Math.min(refereeReward, totalPrice / 2)

    expect(remainingReferralCredit).about(refereeReward - expectedReferralCreditsUsed, 0.0001)

    // Triggering the process to payout to the referrer upon successful first
    // purchase by referee is done via emitting events.
    setTimeout(async function () {
      generalCredits = await m.Credit.getUserCredits(existingUser.userInst.id)
      expect(generalCredits).equal(referrerReward)
      expect(newUser.userInst.notes.pendingPayoutToReferrer).undefined()
    }, 2000)
  })
})
