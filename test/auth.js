const {models: m} = require('../src/lib/core/dbschema')()
const {loginAs, randomEmail} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import * as auth from '../src/lib/core/auth'
import querystring from 'querystring'

export var lab = Lab.script()

lab.experiment("Auth stuff", function () {
  lab.test('adminCredentials', {timeout: 10000}, async function () {
    const adminEmail = randomEmail()
    const adminInst = await m.Admin.create({
      email: adminEmail,
    })
    const companyInst = await m.TransportCompany.create({})

    await adminInst.addTransportCompany(companyInst.id, {permissions: ['abc', 'def', 'ghi']})

    // Check that permissions etc. are all added in
    const credentials = await auth.credentialsFromToken({
      email: adminEmail,
      role: 'admin',
      iat: Date.now(),
    })
    expect(credentials.permissions[companyInst.id]).include('abc')
    expect(credentials.permissions[companyInst.id]).include('def')
    expect(credentials.permissions[companyInst.id]).include('ghi')
    expect(credentials.email).equal(adminInst.email)
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.iat).exist()

    // Check the whoami function
    const response = await server.inject({
      url: '/admins/whoami',
      headers: {authorization: `Bearer ${adminInst.makeToken()}`}
    })
    expect(response.result.scope).equal("admin")
    expect(response.result.adminId).equal(adminInst.id)
    expect(response.result.transportCompanyIds).include(companyInst.id)
  })

  lab.test('superadminCredentials', {timeout: 10000}, async function () {
    const adminEmail = randomEmail()
    const adminInst = await m.Admin.create({
      email: adminEmail,
    })

    // Check that email, adminId are included
    const credentials = await auth.credentialsFromToken({
      email: adminEmail,
      role: 'superadmin',
      iat: Date.now(),
    })

    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.email).equal(adminEmail)
    expect(credentials.iat).exist()

    // Check the whoami function
    const superadminToken = (await loginAs("superadmin", {email: adminEmail})).result.sessionToken
    const response = await server.inject({
      url: '/admins/whoami',
      headers: {authorization: `Bearer ${superadminToken}`},
    })
    expect(response.result.scope).equal("superadmin")
    expect(response.result.adminId).equal(adminInst.id)

    //
    const allCompanyIds = await m.TransportCompany.findAll({attributes: ['id']})
      .then(s => s.map(tc => tc.id))
    for (let companyId of allCompanyIds) {
      expect(response.result.transportCompanyIds).include(companyId)
    }
  })

  lab.test('[admin] credentialsFromToken works with app_metadata', {timeout: 10000}, async function () {
    var adminEmail = randomEmail()
    var adminInst = await m.Admin.create({
      email: adminEmail
    })

      // Check that email, adminId are included
    var credentials = await auth.credentialsFromToken({
      email: adminEmail,
      app_metadata: {
        roles: ['admin'],
        adminId: adminInst.id
      },
      iat: Date.now()
    })
    expect(credentials.adminId).equal(adminInst.id)
  })

  lab.test('[superadmin] credentialsFromToken works with app_metadata', {timeout: 10000}, async function () {
    var adminEmail = randomEmail()
    var adminInst = await m.Admin.create({
      email: adminEmail
    })

      // Check that email, adminId are included
    var credentials = await auth.credentialsFromToken({
      email: adminEmail,
      app_metadata: {
        roles: ['superadmin'],
      },
      iat: Date.now()
    })
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.email).equal(adminEmail)
  })

  lab.test('downloadLink', async () => {
    var userInst = await m.User.create({
      telephone: randomEmail()
    })

    var makeLinkResponse = await server.inject({
      url: '/makeDownloadLink',
      method: 'POST',
      payload: {
        uri: '/user'
      },
      headers: {authorization: `Bearer ${userInst.makeToken()}`}
    })
    expect(makeLinkResponse.statusCode).equal(200)

    var downloadResponse = await server.inject({
      url: '/downloadLink?' + querystring.stringify({token: makeLinkResponse.result.token}),
      method: 'GET',
    })
    expect(downloadResponse.statusCode).equal(200)

    // Need to manually deserialize because streams are not automatically deserialized
    const downloadResult = JSON.parse(downloadResponse.result)
    expect(downloadResult.id).equal(userInst.id)
  })

  lab.test('downloadLink -- with old iat', async () => {
    var userInst = await m.User.create({
      telephone: randomEmail()
    })

    var makeLinkResponse = await server.inject({
      url: '/makeDownloadLink',
      method: 'POST',
      payload: {
        uri: '/user'
      },
      headers: {authorization: `Bearer ${userInst.makeToken(Date.now() - 30 * 60000)}`}
    })
    expect(makeLinkResponse.statusCode).equal(200)

    var downloadResponse = await server.inject({
      url: '/downloadLink?' + querystring.stringify({token: makeLinkResponse.result.token}),
      method: 'GET',
    })
    expect(downloadResponse.statusCode).equal(200)

    // Need to manually deserialize because streams are not automatically deserialized
    const downloadResult = JSON.parse(downloadResponse.result)
    expect(downloadResult.id).equal(userInst.id)
  })
})
