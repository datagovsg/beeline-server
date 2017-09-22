const {models: m} = require('../src/lib/core/dbschema')()
const {randomEmail} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import * as auth from '../src/lib/core/auth'
import querystring from 'querystring'

export var lab = Lab.script()

lab.experiment("Auth stuff", function () {
  lab.test('adminCredentials', {timeout: 10000}, async function () {
    var adminEmail = randomEmail()
    var adminInst = await m.Admin.create({
      email: adminEmail
    })
    var companyInst = await m.TransportCompany.create({})

    await adminInst.addTransportCompany(companyInst.id, {permissions: ['abc', 'def', 'ghi']})

    // Check that permissions etc. are all added in
    var credentials = await auth.credentialsFromToken({
      email: adminEmail,
      adminId: adminInst.id,
      role: 'admin',
      iat: Date.now()
    })
    expect(credentials.permissions[companyInst.id]).include('abc')
    expect(credentials.permissions[companyInst.id]).include('def')
    expect(credentials.permissions[companyInst.id]).include('ghi')
    expect(credentials.email).equal(adminInst.email)
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.iat).exist()

    // Check the whoami function
    var response = await server.inject({
      url: '/admins/whoami',
      headers: {authorization: `Bearer ${adminInst.makeToken()}`}
    })
    expect(response.result.adminId).equal(adminInst.id)
  })

  lab.test('superadminCredentials', {timeout: 10000}, async function () {
    var adminEmail = randomEmail()
    var adminInst = await m.Admin.create({
      email: adminEmail
    })

    // Check that email, adminId are included
    var credentials = await auth.credentialsFromToken({
      email: adminEmail,
      role: 'superadmin',
      iat: Date.now()
    })
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.email).equal(adminEmail)
    expect(credentials.iat).exist()
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
