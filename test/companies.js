import Lab from "lab"

import {expect} from "code"
import server from "../src/index.js"
import _ from "lodash"
import URL from 'url'
import jwt from 'jsonwebtoken'
import querystring from 'querystring'
import sinon from 'sinon'

import {loginAs, randomEmail} from "./test_common"

export const lab = Lab.script()

const {models: m} = require("../src/lib/core/dbschema")()
let testData = require("./test_data")

lab.experiment("Company manipulation", function () {
  let companyId = null
  /* test data */
  let companyInfo = testData.companies[0]
  let updatedCompanyInfo = testData.companies[1]

  lab.before({timeout: 5000}, async function () {
  })

  lab.test("CRUD Companies", async function () {
    // LOGIN as superadmin
    let loginResponse = await loginAs('superadmin')
    let superAuthHeaders = {
      authorization: "Bearer " + loginResponse.result.sessionToken,
    }

    let resp = await server.inject({
      method: "POST",
      url: "/companies",
      // Omit because these should be done via Stripe connect
      payload: _.omit(companyInfo, ['clientId', 'clientSecret', 'sandboxSecret', 'sandboxId']),
      headers: superAuthHeaders,
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.include("id")

    expect(resp.result).includes(_.pick(companyInfo, ['email', 'name', 'features', 'terms']))
    companyId = resp.result.id


    // LOGIN as admin
    loginResponse = await loginAs('admin', {
      transportCompanyId: companyId,
      permissions: ['manage-company'],
    })
    let authHeaders = {
      authorization: "Bearer " + loginResponse.result.sessionToken,
    }

    // LIST
    resp = await server.inject({
      method: "GET",
      url: "/companies",
    })
    expect(resp.result.find(c => c.id === companyId)).exist()
    // ensure heavy attributes are not included
    expect(resp.result.find(c => 'terms' in c)).undefined()
    expect(resp.result.find(c => 'features' in c)).undefined()
    expect(resp.result.find(c => 'logo' in c)).undefined()

    // READ
    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId,
    })

    expect(resp.statusCode).to.equal(200)
    expect(resp.result)
      .includes(_.pick(companyInfo, ['email', 'name', 'features', 'terms']))
    expect(resp.result).to.not.include("clientSecret")
    expect(resp.result).to.not.include("sandboxSecret")

    // UPDATE
    resp = await server.inject({
      method: "PUT",
      url: "/companies/" + companyId,
      headers: authHeaders,
      payload: _.omit(updatedCompanyInfo, ['id', 'clientId', 'clientSecret', 'sandboxSecret', 'sandboxId']),
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result)
      .includes(_.pick(updatedCompanyInfo, ['email', 'name', 'features', 'terms']))

    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId,
    })
    delete updatedCompanyInfo.clientSecret
    delete updatedCompanyInfo.sandboxSecret
    expect(resp.result)
      .includes(_.pick(updatedCompanyInfo, ['email', 'name', 'features', 'terms']))

    // DELETE
    resp = await server.inject({
      method: "DELETE",
      url: "/companies/" + companyId,
      headers: superAuthHeaders,
    })
    expect(resp.statusCode).to.equal(200)

    resp = await server.inject({
      method: "GET",
      url: "/companies/" + companyId,
    })
    expect(resp.statusCode).to.equal(404)
  })

  lab.test('Stripe Connect (partial test)', async function () {
    const adminEmail = randomEmail()
    const adminInst = await m.Admin.create({
      email: adminEmail,
    })
    const companyInst = await m.TransportCompany.create({})

    await adminInst.addTransportCompany(companyInst.id, {permissions: ['manage-company']})

    // Check the whoami function
    const response = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/stripeConnect`,
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
      payload: {
        redirect: 'https://redirect.example.com/',
      },
    })

    const urlResult = URL.parse(response.result, true)
    expect(urlResult.protocol).equal('https:')
    expect(urlResult.hostname).equal('connect.stripe.com')
    expect(urlResult.pathname).equal('/oauth/authorize')
    expect(urlResult.query.response_type).equal('code')
    expect(urlResult.query.scope).equal('read_write')
    expect(urlResult.query.client_id).exist()

    const state = jwt.decode(urlResult.query.state)
    expect(state.action).equal('stripeConnect')
    expect(state.redirect).equal('https://redirect.example.com/')
    expect(state.transportCompanyId).equal(companyInst.id)

    // The actual connecting part
    let sandbox = null
    try {
      sandbox = sinon.sandbox.create()

      sandbox.stub(
        require('../src/lib/transactions/payment'),
        'connectAccount',
        async (code) => {
          expect(code).equal('TEST_TEST_OAUTH_CODE')
          return {
            stripe_user_id: 'TEST_TEST_USER_ID',
            livemode: true,
          }
        }
      )

      // Invalid auth code
      const invalidResponse1 = await server.inject({
        method: 'GET',
        url: `/companies/stripeConnect?` + querystring.stringify({
          code: 'TEST_TEST_FAKE_CODE',
          state: urlResult.query.state,
          scope: 'read_write',
        }),
        headers: {
          authorization: `Bearer ${adminInst.makeToken()}`,
        },
      })
      expect(invalidResponse1.statusCode).equal(500)
      expect((await m.TransportCompany.findById(companyInst.id, {raw: true})).clientId).not.exist()

      // Invalid state (bad token)
      const invalidResponse2 = await server.inject({
        method: 'GET',
        url: `/companies/stripeConnect?` + querystring.stringify({
          code: 'TEST_TEST_OAUTH_CODE',
          state: urlResult.query.state.substr(0, urlResult.query.state.length - 10),
          scope: 'read_write',
        }),
        headers: {
          authorization: `Bearer ${adminInst.makeToken()}`,
        },
      })
      expect(invalidResponse2.statusCode).equal(403)
      expect((await m.TransportCompany.findById(companyInst.id, {raw: true})).clientId).not.exist()

      // Valid response
      const connectResponse = await server.inject({
        method: 'GET',
        url: `/companies/stripeConnect?` + querystring.stringify({
          code: 'TEST_TEST_OAUTH_CODE',
          state: urlResult.query.state,
          scope: 'read_write',
        }),
        headers: {
          authorization: `Bearer ${adminInst.makeToken()}`,
        },
      })
      expect(connectResponse.statusCode).equal(302)
      expect(connectResponse.headers.location).equal(state.redirect)
      expect((await m.TransportCompany.findById(companyInst.id, {raw: true})).clientId).equal('TEST_TEST_USER_ID')
    } catch (err) {
      throw err
    } finally {
      if (sandbox) sandbox.restore()
    }
  })
})
