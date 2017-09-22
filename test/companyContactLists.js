const Lab = require("lab")
const lab = exports.lab = Lab.script()

const {expect} = require("code")
const server = require("../src/index.js")
const _ = require("lodash")

const {loginAs, randomEmail} = require("./test_common")
const {models: m} = require("../src/lib/core/dbschema")()

var testData = require("./test_data")

lab.experiment("Company Phone Whitelist manipulation", function () {
  var companyId = null
  var authHeaders = null
  /* test data */
  var companyInfo = testData.companies[0]

  var phoneInfo = {
    description: 'Test list',
    telephones: ["+6512345678"],
    emails: _.range(0, 10).map(randomEmail),
  }

  lab.before({timeout: 15000}, async function () {
    var companyInst = await m.TransportCompany.create(companyInfo)
    companyId = companyInst.id
    phoneInfo.transportCompanyId = companyId

    // LOGIN as admin
    const loginResponse = await loginAs('admin', {
      transportCompanyId: companyId,
      permissions: ['manage-customers'],
    })
    authHeaders = {
      authorization: "Bearer " + loginResponse.result.sessionToken
    }
  })

  lab.test("CRUD Company Phone Whitelist Integration Test", {timeout: 10000}, async function () {
    // CREATE
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/contactLists",
      payload: _.omit(phoneInfo, 'transportCompanyId'),
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")

    const phoneListId = resp.result.id

    // READ
    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/contactLists/" + phoneListId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result).includes(phoneInfo)

    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/contactLists",
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result[0]).includes(_.omit(phoneInfo, ['telephones', 'emails']))

    // UPDATE
    const newEmail = randomEmail()
    phoneInfo.telephones.push("+6562353535")
    phoneInfo.emails.push(newEmail)

    resp = await server.inject({
      method: "PUT",
      url: "/companies/" + companyId + "/contactLists/" + phoneListId,
      payload: _.pick(phoneInfo, ['telephones', 'emails']),
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result).includes(phoneInfo)

    // DELETE
    resp = await server.inject({
      method: "DELETE",
      url: "/companies/" + companyId + "/contactLists/" + phoneListId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result).includes(phoneInfo)


    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId + "/contactLists/" + phoneListId,
      headers: authHeaders
    })

    expect(resp.statusCode).to.equal(404)
  })

  lab.test("No error if there are no phone lists for that company", {timeout: 10000}, async function () {
    var newCompany = await m.TransportCompany.create(testData.companies[2])
    const loginResponse = await loginAs('admin', {
      transportCompanyId: newCompany,
      permissions: ['manage-customers'],
    })
    let newUserAuth = {
      authorization: "Bearer " + loginResponse.result.sessionToken
    }
    var resp = await server.inject({
      method: "GET",
      url: "/companies/" + newCompany.id + "/contactLists",
      // payload: promoInfo,
      headers: newUserAuth
    })

    expect(resp.statusCode).equal(200)
  })

  lab.test("Bad numbers rejected on creation", {timeout: 10000}, async function () {
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/contactLists",
      payload: { description: 'test', telephones: ['+65banana'] },
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(400)
  })

  lab.test("Bad numbers rejected on update", {timeout: 10000}, async function () {
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/contactLists",
      payload: { description: 'test', telephones: ['+6562353535'], emails: [] },
      headers: authHeaders
    })
    const listId = resp.result.id
    resp = await server.inject({
      method: "PUT",
      url: "/companies/" + companyId + "/contactLists/" + listId,
      payload: { telephones: ['+65banana'] },
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(400)
  })

  lab.test("Bad emails rejected on creation", {timeout: 10000}, async function () {
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/contactLists",
      payload: { description: 'test', emails: ['badEmail@example.'] },
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(400)
  })

  lab.test("Bad emails rejected on update", {timeout: 10000}, async function () {
    var resp = await server.inject({
      method: "POST",
      url: "/companies/" + companyId + "/contactLists",
      payload: { description: 'test', emails: ['goodEmail@example.com'], telephones: [] },
      headers: authHeaders
    })
    const listId = resp.result.id
    resp = await server.inject({
      method: "PUT",
      url: "/companies/" + companyId + "/contactLists/" + listId,
      payload: { emails: ['badEmail@example.'] },
      headers: authHeaders
    })
    expect(resp.statusCode).to.equal(400)
  })
})
