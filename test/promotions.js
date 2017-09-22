const Lab = require("lab")
const lab = exports.lab = Lab.script()
const {expect} = require("code")
const _ = require('lodash')

const server = require("../src/index.js")
const {models: m} = require("../src/lib/core/dbschema")()

const {users} = require("./test_data")

lab.experiment("User referral code administration", function () {
  const user = _.assign({ name: 'John Doe' }, users[0])
  const promo = {
    code: 'TESTING',
    type: 'TEST',
    params: {},
    description: 'For testing',
  }

  var userInstance
  var promoInstance

  lab.before({timeout: 15000}, async () => {
    userInstance = await m.User.create(user)
    promo.params.ownerId = userInstance.id
    promoInstance = await m.Promotion.create(promo)
  })

  lab.after({timeout: 15000}, async () => {
    await promoInstance.destroy()
    await userInstance.destroy()
  })

  lab.test("/promotions/refCodeOwner -> user details", async () => {
    const resp = await server.inject({
      method: "GET",
      url: "/promotions/refCodeOwner?code=" + promo.code,
    })
    expect(resp.statusCode).to.equal(200)
    expect(resp.result).to.equal({
      name: userInstance.name,
      referrerId: userInstance.id,
    })
  })


  lab.test("Bad /promotions/refCodeOwner -> 404", async () => {
    const resp = await server.inject({
      method: "GET",
      url: "/promotions/refCodeOwner?code=" + 'banana',
    })
    expect(resp.statusCode).to.equal(404)
  })
})
