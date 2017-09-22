const Lab = require("lab")
const lab = exports.lab = Lab.script()

const {expect} = require("code")
const server = require("../src/index.js")
const _ = require("lodash")

const {loginAs} = require("./test_common")
const {models: m} = require("../src/lib/core/dbschema")()

var testData = require("./test_data")

lab.experiment("Company Promo manipulation", function () {
  var companyId = null
  var userId = null
  var sleepingUserId = null
  var authHeaders = null
  /* test data */
  var companyInfo = testData.companies[0]
  var userInfo = testData.users[0]
  var sleepingUserInfo = testData.users[1]

  var promoInfo = {
    code: 'TESTER',
    type: 'Promotion',
    description: 'A test promotion',

    params: {
      tag: 'testing',
      creditAmt: 200,
      qualifyingCriteria: [
        {type: 'limitByCompany', params: {}}
      ],
      discountFunction: {
        type: 'simpleRate',
        params: { rate: 1 },
      },
      refundFunction: {
        type: 'refundDiscountedAmt',
        params: {},
      },
      usageLimit: {
        userLimit: null,
        globalLimit: null,
      },
    },
  }

  lab.before({timeout: 15000}, async function () {
    var companyInst = await m.TransportCompany.create(companyInfo)
    companyId = companyInst.id
    promoInfo.params.qualifyingCriteria[0].params.companyId = companyId

    var userInst = await m.User.create(userInfo)
    userId = userInst.id

    const sleepingUserInst = await m.User.create(sleepingUserInfo)
    sleepingUserId = sleepingUserInst.id

    // LOGIN as admin
    const loginResponse = await loginAs('admin', {
      transportCompanyId: companyId,
      permissions: ['manage-company'],
    })
    authHeaders = {
      authorization: "Bearer " + loginResponse.result.sessionToken
    }
  })

  lab.test("CRUD Company Promo Integration Test", {timeout: 10000}, async function () {
    // CREATE
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/promotions",
      payload: promoInfo,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")

    const promoId = resp.result.id

    var globalPromoUsage = await m.PromoUsage.create({ userId: null, promoId, count: 3 })
    var userPromoUsage = await m.PromoUsage.create({ userId, promoId, count: 3 })
    var sleepingUserPromoUsage = await m.PromoUsage.create({ userId: sleepingUserId, promoId, count: 0 })
    // READ
    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/promotions/" + promoId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result)
      .includes(_.pick(promoInfo, _.without(_.keys(promoInfo), 'params')))
    expect(resp.result.params.qualifyingCriteria[0].type)
      .to.equal(promoInfo.params.qualifyingCriteria[0].type)
    expect(resp.result.counts.global).to.equal(globalPromoUsage.count)
    expect(resp.result.counts.distinctUsers).to.equal(1)

    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/promotions",
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result[0])
      .includes(_.pick(promoInfo, _.without(_.keys(promoInfo), 'params')))
    expect(resp.result[0].params.qualifyingCriteria[0].type)
      .to.equal(promoInfo.params.qualifyingCriteria[0].type)

    const zeroQualification = {
      type: 'Promotion',
      params: {
        qualifyingCriteria: [
          {type: 'limitByCompany', params: {companyId: companyId}},
          {
            type: 'limitByRoute',
            params: { routeIds: [1] },
          }
        ]
      }
    }

    // UPDATE
    resp = await server.inject({
      method: "PUT",
      url: "/companies/" + companyId + "/promotions/" + promoId,
      payload: zeroQualification,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result)
      .includes(_.pick(promoInfo, _.without(_.keys(promoInfo), 'params')))
    expect(resp.result.params.qualifyingCriteria[1].type)
      .to.equal(zeroQualification.params.qualifyingCriteria[1].type)

    userPromoUsage.destroy()
    globalPromoUsage.destroy()
    sleepingUserPromoUsage.destroy()

    // DELETE
    resp = await server.inject({
      method: "DELETE",
      url: "/companies/" + companyId + "/promotions/" + promoId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result)
      .includes(_.pick(promoInfo, _.without(_.keys(promoInfo), 'params')))
    expect(resp.result.params.qualifyingCriteria[1].type)
      .to.equal(zeroQualification.params.qualifyingCriteria[1].type)


    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/promotions/" + promoId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(404)
  })

  lab.test("No error if there are no promos for that company", {timeout: 10000}, async function () {
    var newCompany = await m.TransportCompany.create(testData.companies[2])
    await m.User.create(testData.users[1])
    const loginResponse = await loginAs('admin', {
      transportCompanyId: newCompany,
      permissions: ['manage-company'],
    })
    let newUserAuth = {
      authorization: "Bearer " + loginResponse.result.sessionToken
    }
    var resp = await server.inject({
      method: "GET",
      url: "/companies/" + newCompany.id + "/promotions",
      // payload: promoInfo,
      headers: newUserAuth
    })

    expect(resp.statusCode).equal(200)
  })

  lab.test("POST RoutePass promotion with valid criteria -> OK", {timeout: 10000}, async function () {
    const newPromoInfo = _.assign({}, promoInfo)
    newPromoInfo.type = 'RoutePass'
    // CREATE
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/promotions",
      payload: newPromoInfo,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")
  })

  lab.test("POST RoutePass promotion with invalid criteria -> 400", {timeout: 10000}, async function () {
    const newPromoInfo = _.assign({}, promoInfo)
    newPromoInfo.type = 'RoutePass'
    newPromoInfo.params.qualifyingCriteria.push({ type: 'limitByRoute', params: {} })

    // CREATE
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/promotions",
      payload: newPromoInfo,
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(400)
  })
})
