var Lab = require("lab")
var lab = exports.lab = Lab.script()

const {expect} = require("code")
var server = require("../src/index.js")
var common = require("../src/lib/util/common")

var defaultErrorHandler = common.defaultErrorHandler

var Sequelize = require("sequelize")
var {loginAs, randomEmail, cleanlyDeleteUsers} = require("./test_common")
const {db, models} = require("../src/lib/core/dbschema")()
const sinon = require('sinon')
const sms = require("../src/lib/util/sms")
const emailModule = require("../src/lib/util/email")

import * as auth from "../src/lib/core/auth"
import * as onesignal from "../src/lib/util/onesignal"
import qs from "querystring"
import jwt from "jsonwebtoken"
import axios from 'axios'

lab.experiment("User manipulation", function () {
  let authHeaders = {}
  let email = "test" + Date.now() + "@example.com"
  let testPhoneNumbers = ["+6581001860", "+6599999999", "+6501234567", '+6565431234']
  let adminInstance

  let sandbox

  lab.before(async function () {
    adminInstance = await models.Admin.create({
      email: `testadmin${new Date().getTime()}@example.com`,
    })

    var adminToken = adminInstance.makeToken()
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    var superToken = (await loginAs("superadmin")).result.sessionToken
    authHeaders.super = {authorization: "Bearer " + superToken}
  })

  lab.beforeEach(async function () {
    sandbox = sinon.sandbox.create()

    await cleanlyDeleteUsers({
      telephone: {$in: testPhoneNumbers}
    })
  })

  lab.afterEach(async function () {
    sandbox.restore()
  })

  lab.test('Telephone-based user creation', {timeout: 10000}, async function () {
    var response = await server.inject({
      method: 'POST',
      url: '/users/sendTelephoneVerification?dryRun=true',
      payload: {telephone: '+6581001860'}
    })
    expect(response.statusCode).equal(200)

      // Ensure User is created after send telephone verification
    var userInst = await models.User.find({
      where: {telephone: '+6581001860'}
    })
    expect(userInst).exist()
    expect(userInst.status).equal('unverified')

      // Extract the user's code
    expect(userInst.get('telephoneCode', {raw: true})).to.exist()

      // Delete the code...
    await userInst.update({
      telephoneCode: '000',
      lastComms: null,
    })

    var response2 = await server.inject({
      method: 'POST',
      url: '/users/sendTelephoneVerification?dryRun=true',
      payload: {telephone: '+6581001860'}
    })
    expect(response2.statusCode).equal(200)

    var userInst = await models.User.find({
      where: {telephone: '+6581001860'}
    })
    expect(userInst).exist()
    expect(userInst.get('telephoneCode', {raw: true})).not.equal('000')
  })

  lab.test("User telephone verification", async function () {
    const email = randomEmail()
    const telephone = testPhoneNumbers[3]
    let codeInSMS = null

    sandbox.stub(sms, 'sendSMS', (options) => {
      expect(options.to).equal(telephone)

      const match = options.body.match(/[0-9]{6}/)

      expect(match).exist()
      codeInSMS = match[0]
    })

    // "Send" the verification
    var response = await server.inject({
      method: "POST",
      url: "/users/sendTelephoneVerification",
      payload: {telephone}
    })
    expect(response.statusCode).to.equal(200)

    var response2 = await server.inject({
      method: "POST",
      url: "/users/verifyTelephone",
      payload: {
        code: "000",
        telephone
      }
    })
    expect(response2.statusCode).to.equal(401)

    let code = (await models.User.find({
      where: {telephone},
      raw: true
    })).telephoneCode

    expect(code).equal(codeInSMS)

    var response3 = await server.inject({
      method: "POST",
      url: "/users/verifyTelephone",
      payload: {code, telephone}
    })
    expect(response3.statusCode).to.equal(200)
    expect(response3.result.user).to.exist()
    expect(response3.result.sessionToken).to.exist()

    // Cannot use the code a second time
    var response4 = await server.inject({
      method: "POST",
      url: "/users/verifyTelephone",
      payload: {code, telephone}
    })
    expect(response4.statusCode).not.equal(200)
  })

  lab.test("Code expiry", async function () {

    const email = randomEmail()
    const telephone = testPhoneNumbers[3]
    let codeInSMS = null

    sandbox.stub(sms, 'sendSMS', (options) => {
      expect(options.to).equal(telephone)

      const match = options.body.match(/[0-9]{6}/)

      expect(match).exist()
      codeInSMS = match[0]
    })

    // "Send" the verification
    var response = await server.inject({
      method: "POST",
      url: "/users/sendTelephoneVerification",
      payload: {telephone}
    })

    expect(response.statusCode).to.equal(200)

    // Stub Date.now() to return something beyond 30 mins
    const now = Date.now()
    sandbox.stub(Date, 'now', () => now + 30 * 60000)

    var response2 = await server.inject({
      method: "POST",
      url: "/users/verifyTelephone",
      payload: {
        code: codeInSMS,
        telephone
      }
    })
    expect(response2.statusCode).to.equal(401)

    // Restore the time...
    sandbox.restore()
    var response3 = await server.inject({
      method: "POST",
      url: "/users/verifyTelephone",
      payload: {
        code: codeInSMS,
        telephone
      }
    })
    expect(response3.statusCode).to.equal(200) // voila!
  })

  lab.test("Email verification", async function () {

    const email = randomEmail()
    const userInst = await models.User.create({
      telephone: testPhoneNumbers[0],
      email
    })

    let callArgs = null
    const stub = sandbox.stub(emailModule, 'sendMail', function (options) {
      callArgs = options
      return Promise.resolve(null)
    })

    // Request verification
    const requestResponse = await server.inject({
      method: "POST",
      url: "/users/sendEmailVerification",
      headers: {authorization: `Bearer ${userInst.makeToken()}`}
    })
    expect(requestResponse.statusCode).to.equal(200)

    // Get the token
    expect(callArgs.text.indexOf(`https://${process.env.WEB_DOMAIN}/users/verifyEmail?token=`)).not.equal(-1)

    //
    const match = callArgs.text.match(/(\/users\/verifyEmail\?token=([-_a-zA-Z0-9\.]*))[^-_a-zA-Z0-9\.]/)
    expect(match[2]).exist()

    const token = match[2]

    expect(userInst.emailVerified).false()
    const response2 = await server.inject({
      method: "GET",
      url: `/users/verifyEmail?token=${token}`,
    })
    expect(response2.statusCode).to.equal(302)

    await userInst.reload()
    expect(userInst.emailVerified).true()

    // Cannot verify a second time
    const response3 = await server.inject({
      method: "GET",
      url: `/users/verifyEmail?token=${token}`,
    })
    expect(response3.statusCode).to.equal(400)
  })

  lab.test("User update telephone", async function () {
    var email = "test" + new Date().getTime() + "@example.com"

    var userInst = await models.User.create({
      telephone: "+6581001860",
      name: "testuser!",
      email: email
    })
    var otherInst = await models.User.create({
      telephone: "+6599999999",
      name: "testuser!",
      email: email
    })

    var headers = {
      authorization: "Bearer " + userInst.makeToken()
    }

      // Update the telephone by obtaining the updateToken
    var response = await server.inject({
      method: "POST",
      url: "/user/requestUpdateTelephone",
      payload: {
        newTelephone: "+6599999999",
        dryRun: true
      },
      headers: headers
    })
    expect(response.statusCode).to.equal(200)
    expect(response.result).to.include("updateToken")

            // pull the code from the database
    userInst = await models.User.findById(userInst.id, {raw: true})

    expect(userInst.telephoneCode).to.exist()
    expect(userInst.telephone).to.equal("+6581001860")

            // really update the telephone
    var response2 = await server.inject({
      method: "POST",
      url: "/user/updateTelephone",
      payload: {
        updateToken: response.result.updateToken,
        code: userInst.telephoneCode
      },
      headers: headers
    })
    expect(response2.statusCode).to.equal(200)

            // pull the code from the database
    userInst = await models.User.findById(userInst.id, {raw: true})
    expect(userInst.telephoneCode).to.not.exist()
    expect(userInst.telephone).to.equal("+6599999999")

            // expect the other user to have nulled telephone
    otherInst = await models.User.findById(otherInst.id, {raw: true})
    expect(otherInst.telephone).to.equal(null)
  })

  lab.test('One login per user', {timeout: 5000}, async function () {
    var name = `Random name`
    var telephone = `+6501234567`

    var userInst = await models.User.create({
      name, telephone, telephoneCode: '123456'
    })

      // Try to login as the user
    var response1 = await server.inject({
      url: '/users/verifyTelephone',
      method: 'POST',
      payload: {
        telephone,
        code: '123456'
      }
    })
    expect(response1.statusCode).equal(200)
    expect(response1.result.sessionToken).exist()
    var userResponse = await server.inject({
      url: '/user',
      method: 'GET',
      headers: { authorization: `Bearer ${response1.result.sessionToken}`}
    })
    expect(userResponse.statusCode).equal(200)
    expect(userResponse.result.id).equal(userInst.id)

      // Because of the 1-second granularity with tokens, wait 1.5s
    await new Promise((resolve) => setTimeout(resolve, 1500))

      // Login a second time
    await userInst.update({
      telephoneCode: '654321'
    })
    var response2 = await server.inject({
      url: '/users/verifyTelephone',
      method: 'POST',
      payload: {telephone, code: '654321'}
    })
    expect(response2.statusCode).equal(200)
    expect(response2.result.sessionToken).exist()

      // The request with the new token should succeed
    userResponse = await server.inject({
      url: '/user',
      method: 'GET',
      headers: {authorization: `Bearer ${response2.result.sessionToken}`}
    })
    expect(userResponse.statusCode).equal(200)
    expect(userResponse.result.id).equal(userInst.id)

      // But the request with the old token should not
    userResponse = await server.inject({
      url: '/user',
      method: 'GET',
      headers: {authorization: `Bearer ${response1.result.sessionToken}`}
    })
    expect(userResponse.statusCode).equal(403)
  })

  lab.test('Get telephoneCode works for superadmins', {timeout: 5000}, async function () {
    let code = Date.now().toString()
    let userInst = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: testPhoneNumbers[0],
      telephoneCode: code
    })

    let resp1 = await server.inject({
      url: `/user/${userInst.id}/telephoneCode`,
      method: 'GET',
      headers: authHeaders.super
    })
    expect(resp1.statusCode).equal(200)
    expect(resp1.result).equal(code)

    await userInst.update({telephoneCode: null})

    let resp2 = await server.inject({
      url: `/user/${userInst.id}/telephoneCode`,
      method: 'GET',
      headers: authHeaders.super
    })
    expect(resp2.statusCode).equal(200)

    await userInst.reload()
    expect(resp2.result).equal(userInst.dataValues.telephoneCode)
  })

  lab.test('Get telephoneCode fails for all other user types', {timeout: 5000}, async function () {
    let code = Date.now()
    let userInst = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: testPhoneNumbers[0],
      telephoneCode: code
    })

    let randomUser = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user1",
      telephone: testPhoneNumbers[1],
    })
    let userToken = randomUser.makeToken()
    let userAuthHeader = {authorization: "Bearer " + userToken}

    // admin
    let resp1 = await server.inject({
      url: `/user/${userInst.id}/telephoneCode`,
      method: 'GET',
      headers: authHeaders.admin
    })
    expect(resp1.statusCode).equal(403)

    // random user
    let resp2 = await server.inject({
      url: `/user/${userInst.id}/telephoneCode`,
      headers: userAuthHeader,
      method: 'GET',
    })
    expect(resp2.statusCode).equal(403)

    // non-logged in
    let resp3 = await server.inject({
      url: `/user/${userInst.id}/telephoneCode`,
      method: 'GET',
    })
    expect(resp3.statusCode).equal(403)
  })

  lab.test('Get telephoneCode fails gracefully for bad userId provided', {timeout: 5000}, async function () {
    let resp1 = await server.inject({
      url: '/user/1000000/telephoneCode',
      method: 'GET',
      headers: authHeaders.super
    })
    expect(resp1.statusCode).equal(404)

    let resp2 = await server.inject({
      url: `/user/abc/telephoneCode`,
      method: 'GET',
      headers: authHeaders.super
    })
    expect(resp2.statusCode).equal(400)
  })

  lab.test('Get User info for admins', {timeout: 5000}, async function () {
    let userInst = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: testPhoneNumbers[0],
    })

    let randomUser = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user1",
      telephone: testPhoneNumbers[1],
    })
    let userToken = randomUser.makeToken()
    let userAuthHeader = {authorization: "Bearer " + userToken}

    let noLoginResponse = await server.inject({
      url: `/user/${userInst.id}`,
      method: 'GET',
    })

    let badTokenResponse = await server.inject({
      url: `/user/${userInst.id}`,
      method: 'GET',
      headers: {authorization: "BadToken"}
    })

    let userResponse = await server.inject({
      url: `/user/${userInst.id}`,
      method: 'GET',
      headers: userAuthHeader
    })

    let badUserResponse = await server.inject({
      url: `/user/10000000`,
      method: 'GET',
      headers: authHeaders.admin
    })

    let adminResponse = await server.inject({
      url: `/user/${userInst.id}`,
      method: 'GET',
      headers: authHeaders.admin
    })

    let superAdminResponse = await server.inject({
      url: `/user/${userInst.id}`,
      method: 'GET',
      headers: authHeaders.super
    })

    expect(noLoginResponse.statusCode).equal(403)
    expect(badTokenResponse.statusCode).equal(403)
    expect(userResponse.statusCode).equal(403)
    expect(badUserResponse.statusCode).equal(404)

    expect(adminResponse.statusCode).equal(200)
    expect(superAdminResponse.statusCode).equal(200)

    expect(adminResponse.result.id).equal(userInst.id)
    expect(superAdminResponse.result.id).equal(userInst.id)
  })

  lab.test('Email verification hooks', async function () {

    const email1 = randomEmail()
    const email2 = randomEmail()

    const user = await models.User.create({
      email: email1
    })
    expect(user.emailVerified).false()

    await user.update({emailVerified: true})
    expect(user.emailVerified).true()

    await user.update({email: email2})
    expect(user.emailVerified).false()
  })

  lab.test('Create push notification tag', async function () {

    const userInst = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: testPhoneNumbers[0],
    })

    const postResult = await server.inject({
      method: 'POST',
      url: `/user/push_notification_tag`,
      headers: {
        authorization: `Bearer ${userInst.makeToken()}`
      }
    })
    expect(postResult.statusCode).equal(200)
    const tag = postResult.result.tag

    await userInst.reload()
    expect(userInst.notes.pushNotificationTag).equal(tag)
  })

  lab.test('Send push notification', {timeout: 10000}, async function () {

    const userInst = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: testPhoneNumbers[0],
      notes: {
        pushNotificationTag: '0000-0000-0000-0000',
      }
    })

    expect(!!userInst.canSendNotification)

    const notification = {
      title: 'Hello world!',
      message: 'I said hello!',
    }

    const axiosPost = sandbox.stub(axios, 'post', function (url, body, opts) {
      expect(body.headings.en === notification.title)
      expect(body.contents.en === notification.message)
      return Promise.resolve({data: {}})
    })

    await userInst.sendNotification(notification)

    expect(axiosPost.called).true()
  })
})
