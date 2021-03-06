const {models: m} = require("../src/lib/core/dbschema")()
const {loginAs, randomEmail} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import * as auth from "../src/lib/core/auth"

export const lab = Lab.script()

lab.experiment("Auth stuff", function () {
  lab.test("adminCredentials", {timeout: 10000}, async function () {
    const adminEmail = randomEmail()
    const adminInst = await m.Admin.create({
      email: adminEmail,
    })
    const companyInst = await m.TransportCompany.create({})

    await adminInst.addTransportCompany(companyInst.id, {permissions: ["abc", "def", "ghi"]})

    // Check that permissions etc. are all added in
    const credentials = await auth.credentialsFromToken({
      email: adminEmail,
      role: "admin",
      iat: Date.now(),
    })
    expect(credentials.permissions[companyInst.id]).include("abc")
    expect(credentials.permissions[companyInst.id]).include("def")
    expect(credentials.permissions[companyInst.id]).include("ghi")
    expect(credentials.email).equal(adminInst.email)
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.iat).exist()

    // Check the whoami function
    const response = await server.inject({
      url: "/admins/whoami",
      headers: {authorization: `Bearer ${adminInst.makeToken()}`},
    })
    expect(response.result.scope).equal("admin")
    expect(response.result.adminId).equal(adminInst.id)
    expect(response.result.transportCompanyIds).include(companyInst.id)
  })

  lab.test("superadminCredentials", {timeout: 10000}, async function () {
    const adminEmail = randomEmail()
    const adminInst = await m.Admin.create({
      email: adminEmail,
    })

    // Check that email, adminId are included
    const credentials = await auth.credentialsFromToken({
      email: adminEmail,
      role: "superadmin",
      iat: Date.now(),
    })

    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.email).equal(adminEmail)
    expect(credentials.iat).exist()

    // Check the whoami function
    const superadminToken = (await loginAs("superadmin", {email: adminEmail})).result.sessionToken
    const response = await server.inject({
      url: "/admins/whoami",
      headers: {authorization: `Bearer ${superadminToken}`},
    })
    expect(response.result.scope).equal("superadmin")
    expect(response.result.adminId).equal(adminInst.id)

    //
    const allCompanyIds = await m.TransportCompany.findAll({attributes: ["id"]})
      .then(s => s.map(tc => tc.id))
    for (let companyId of allCompanyIds) {
      expect(response.result.transportCompanyIds).include(companyId)
    }
  })

  lab.test("[admin] credentialsFromToken works with app_metadata", {timeout: 10000}, async function () {
    let adminEmail = randomEmail()
    let adminInst = await m.Admin.create({
      email: adminEmail,
    })

      // Check that email, adminId are included
    let credentials = await auth.credentialsFromToken({
      email: adminEmail,
      app_metadata: {
        roles: ["admin"],
        adminId: adminInst.id,
      },
      iat: Date.now(),
    })
    expect(credentials.adminId).equal(adminInst.id)
  })

  lab.test("[superadmin] credentialsFromToken works with app_metadata", {timeout: 10000}, async function () {
    let adminEmail = randomEmail()
    let adminInst = await m.Admin.create({
      email: adminEmail,
    })

      // Check that email, adminId are included
    let credentials = await auth.credentialsFromToken({
      email: adminEmail,
      app_metadata: {
        roles: ["superadmin"],
      },
      iat: Date.now(),
    })
    expect(credentials.adminId).equal(adminInst.id)
    expect(credentials.email).equal(adminEmail)
  })

  lab.test("download link", async () => {
    let userInst = await m.User.create({
      telephone: randomEmail(),
    })

    let makeLinkResponse = await server.inject({
      url: "/downloads",
      method: "POST",
      payload: {
        uri: "/user",
      },
      headers: {authorization: `Bearer ${userInst.makeToken()}`},
    })
    expect(makeLinkResponse.statusCode).equal(200)

    let downloadResponse = await server.inject({
      url: `/downloads/${makeLinkResponse.result.token}`,
      method: "GET",
    })
    expect(downloadResponse.statusCode).equal(200)

    // Need to manually deserialize because streams are not automatically deserialized
    const downloadResult = JSON.parse(downloadResponse.result)
    expect(downloadResult.id).equal(userInst.id)
  })

  lab.test(" -- with old iat", async () => {
    let userInst = await m.User.create({
      telephone: randomEmail(),
    })

    let makeLinkResponse = await server.inject({
      url: "/downloads",
      method: "POST",
      payload: {
        uri: "/user",
      },
      headers: {authorization: `Bearer ${userInst.makeToken(Date.now() - 30 * 60000)}`},
    })
    expect(makeLinkResponse.statusCode).equal(200)

    let downloadResponse = await server.inject({
      url: `/downloads/${makeLinkResponse.result.token}`,
      method: "GET",
    })
    expect(downloadResponse.statusCode).equal(200)

    // Need to manually deserialize because streams are not automatically deserialized
    const downloadResult = JSON.parse(downloadResponse.result)
    expect(downloadResult.id).equal(userInst.id)
  })
})
