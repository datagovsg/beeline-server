var Lab = require("lab")
export var lab = Lab.script()

var {expect} = require("code")
var server = require("../src/index.js")

const {randomEmail} = require("./test_common")
const {models: m} = require("../src/lib/core/dbschema")()

const loginAs = require("./test_common").loginAs

lab.experiment("Admin manipulation", function () {
  var company1, company2

  /** Helper function -- since we only accept lower-case admin emails */
  function randomCapitalize (s) {
    return s.replace(/./g, (m) =>
      (Math.random() > 0.5) ? m.toUpperCase() : m.toLowerCase()
    )
  }

  lab.before({timeout: 40000}, async function () {
    company1 = await m.TransportCompany.create({
      name: "Test Transport company1"
    })
    company2 = await m.TransportCompany.create({
      name: "Test Transport company2"
    })
  })

  lab.after(async function () {
    await company1.destroy()
    await company2.destroy()
  })

  lab.test("Manipulate admins", async function () {
    var superuserResponse = await loginAs("superadmin", {}, server)
    var superuserHeaders = {
      authorization: "Bearer " + superuserResponse.result.sessionToken
    }

      // delete all admins first
    await m.AdminCompany.destroy({
      where: {transportCompanyId: company1.id}
    })

    // Create admin (by superuser)
    var email1 = randomEmail()
    var createResponse = await server.inject({
      method: "POST",
      url: `/companies/${company1.id}/admins`,
      payload: {
        email: randomCapitalize(email1),
        name: "Test1Name",
      },
      headers: superuserHeaders
    })
    expect(createResponse.statusCode).to.equal(200)
    var adminInst = await m.Admin.findById(createResponse.result.id)
    expect(adminInst.email === email1)

    // Login as the admin
    var adminHeaders = {authorization: 'Bearer ' + adminInst.makeToken()}

    // Ensure admin can modify his own name:
    var newName = `my name is ${Date.now()}`
    var newEmail = randomEmail()
    var putResponse = await server.inject({
      method: 'PUT',
      url: `/admins/${adminInst.id}`,
      payload: {
        name: newName,
        email: randomCapitalize(newEmail),
      },
      headers: adminHeaders
    })
    expect(putResponse.statusCode).equal(200)
    adminInst = await m.Admin.findById(putResponse.result.id)
    expect(adminInst.email).equal(newEmail)
    expect(adminInst.name).equal(newName)

    var getResponse = await server.inject({
      method: 'GET',
      url: `/admins/${adminInst.id}`,
      headers: adminHeaders
    })
      // Authentication fails because email changed
    expect(getResponse.statusCode).equal(403)

    // Reauthorize the admin...
    adminHeaders.authorization = `Bearer ${adminInst.makeToken()}`
    getResponse = await server.inject({
      method: 'GET',
      url: `/admins/${adminInst.id}`,
      headers: adminHeaders
    })
    // and it works!
    expect(getResponse.statusCode).equal(200)
    expect(getResponse.result.email).equal(newEmail)
    expect(getResponse.result.name).equal(newName)

    // Check GET /admins works
    var listResponse = await server.inject({
      method: 'GET',
      url: `/companies/${company1.id}/admins`,
      headers: superuserHeaders
    })
    expect(listResponse.result.find(a => a.id === adminInst.id)).exist()

    // This admin can't do anything yet. Try creating other admins.
    var email2 = randomEmail()
    createResponse = await server.inject({
      method: "POST",
      url: `/companies/${company1.id}/admins`,
      payload: {
        email: randomCapitalize(email2),
        name: "rrra",
      },
      headers: adminHeaders
    })
    expect(createResponse.statusCode).to.equal(403)
    var adminInst2 = await m.Admin.find({
      where: { email: email2 },
      include: [
        {
          model: m.TransportCompany,
          where: {id: company1.id}
        }
      ]
    })
    expect(adminInst2).not.exist()

    // Now grant him the power
    await m.AdminCompany
      .find({where: {adminId: adminInst.id, transportCompanyId: company1.id}})
      .then((adminCompany) => adminCompany.update({permissions: ['manage-admins']}))

    // Run the query again...
    createResponse = await server.inject({
      method: "POST",
      url: `/companies/${company1.id}/admins`,
      payload: {
        email: randomCapitalize(email2),
        name: "rrra",
      },
      headers: adminHeaders
    })
    expect(createResponse.statusCode).to.equal(200)
    expect(createResponse.result.email).equal(email2)
    // And it should work!
    adminInst2 = await m.Admin.find({
      where: { email: email2 },
      include: [
        {
          model: m.TransportCompany,
          where: {id: company1.id}
        }
      ]
    })
    expect(adminInst2.email).equal(email2)

    // And he should be able to change permissions...
    createResponse = await server.inject({
      method: "PUT",
      url: `/companies/${company1.id}/admins/${adminInst2.id}`,
      payload: {
        permissions: ['example-permission']
      },
      headers: adminHeaders
    })
    expect(createResponse.statusCode).equal(200)
    // And it should work!
    adminInst2 = await m.Admin.find({
      where: { email: email2 },
      include: [
        {
          model: m.TransportCompany,
          where: {id: company1.id}
        }
      ]
    })
    expect(adminInst2.transportCompanies.find(tc => tc.id === company1.id)
      .adminCompany.permissions.indexOf('example-permission')).not.equal(-1)

    // And he should be able to delete admins...
    createResponse = await server.inject({
      method: "DELETE",
      url: `/companies/${company1.id}/admins/${adminInst2.id}`,
      headers: adminHeaders
    })
    expect(createResponse.statusCode).equal(200)
    adminInst2 = await m.Admin.find({
      where: { email: email2 },
      include: [
        {
          model: m.TransportCompany,
          where: {id: company1.id}
        }
      ]
    })
    expect(adminInst2).not.exist()
  })
})
