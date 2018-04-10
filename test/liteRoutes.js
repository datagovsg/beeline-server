
const Lab = require("lab")
export const lab = Lab.script()

const { expect } = require("code")
const server = require("../src/index.js")

const {models} = require("../src/lib/core/dbschema")()
const {loginAs} = require("./test_common")

lab.experiment("Lite route retrievals", function () {
  let routeLabel = "L1"
  let liteUserName = "Test use r r r r"
  let liteRouteInfo = {
    name: "Name for Lite Testing",
    from: "Testing Lite Route From",
    to: "Testing Lite Route To",
    path: JSON.stringify({testing: "liteTesting"}),
    tags: ["lite"],
    features: "* feature 1",
    label: routeLabel,
  }

  lab.before(async () => {
    await models.Route.create(liteRouteInfo)
  })

  lab.after(async () => {
    // cleanup our test user
    await models.Subscription.destroy({
      where: { routeLabel },
    })
    await models.Route.destroy({
      where: { tags: {$contains: ["lite"]} },
    })
    await models.User.destroy({
      where: { name: liteUserName },
    })
  })

  // lite subscriptions
  lab.test("lite route subscriptions CRUD", async function () {
    let user = await models.User.create({
      email: "testuser1" + new Date().getTime() +
                  "@testtestexample.com",
      name: liteUserName,
      telephone: Date.now(),
    })
    // LOGIN
    let loginResponse = await loginAs("user", user.id)
    let headers = {
      authorization: "Bearer " + loginResponse.result.sessionToken,
    }
    // CREATE
    const createResponse = await server.inject({
      method: "POST",
      url: `/routes/lite/${routeLabel}/subscription`,
      headers,
    })
    expect(createResponse.statusCode).to.equal(200)
    expect(createResponse.result.status).to.equal("valid")

    // READ
    const readResponse = await server.inject({
      method: "GET",
      url: "/routes/lite/subscriptions",
      headers,
    })
    expect(readResponse.statusCode).to.equal(200)
    expect(readResponse.result[0].status).to.equal("valid")
    expect(readResponse.result[0].routeLabel).to.equal(routeLabel)

    // DELETE
    const deleteResponse = await server.inject({
      method: "DELETE",
      url: `/routes/lite/${routeLabel}/subscription`,
      headers,
    })
    expect(deleteResponse.statusCode).to.equal(200)
    expect(deleteResponse.result.status).to.equal("invalid")

    const readAfterDeleteResponse = await server.inject({
      method: "GET",
      url: "/routes/lite/subscriptions",
      headers,
    })
    expect(readAfterDeleteResponse.statusCode).to.equal(200)
    expect(readAfterDeleteResponse.result.length).to.equal(0)
  })

})
