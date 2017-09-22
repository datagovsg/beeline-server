var Lab = require("lab")
export var lab = Lab.script()
const {expect} = require("code")
const {models: m} = require("../src/lib/core/dbschema")()

lab.experiment("Privacy checks", function () {
  lab.test("Password hash", async function () {
    var userInstance = await m.User.create({
      name: 'Some name',
      email: `test${Date.now()}@example.com`,
      password: 'Hello world!',
    })

    var user = userInstance.get()

    expect(user.passwordHash).not.exist()
    expect(user.password).not.exist()
    expect(user.name).exist()
    expect(user.email).exist()
  })

  lab.test("Company info", async function () {
    var companyInstance = await m.TransportCompany.create({
      name: 'Some name',
      clientId: 'clientId',
      clientSecret: 'clientSecret',
      sandboxId: 'sandboxId',
      sandboxSecret: 'sandboxSecret',
    })

    var company = companyInstance.get()

    expect(company.clientId).not.exist()
    expect(company.clientSecret).not.exist()
    expect(company.sandboxId).not.exist()
    expect(company.sandboxSecret).not.exist()
  })
})
