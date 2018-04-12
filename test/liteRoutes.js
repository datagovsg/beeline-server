
const Lab = require("lab")
export const lab = Lab.script()

const { expect } = require("code")
const server = require("../src/index.js")

const {models} = require("../src/lib/core/dbschema")()
const {loginAs} = require("./test_common")
const {createUsersCompaniesRoutesAndTrips} = require("./test_data")

lab.experiment("Lite route retrievals", function () {
  let routeLabel = "L1"
  let [userInstance, companyInstance, routeInstance, tripInstances] = []

  lab.before(async () => {

    ({userInstance, companyInstance, routeInstance, tripInstances} =
        await createUsersCompaniesRoutesAndTrips(models))

    await routeInstance.update({
      tags: ["lite"],
      label: routeLabel,
    })
  })

  lab.after(async () => {
    // cleanup our test user
    await models.Subscription.destroy({
      where: { routeLabel },
    })
    await Promise.all(tripInstances.map(t => t.destroy()))
    await routeInstance.destroy()
    await companyInstance.destroy()
    await userInstance.destroy()
  })

  lab.test("lite route retrieval", async function () {
    const readResponse = await server.inject({
      method: "GET",
      url: "/routes/lite",
    })
    expect(readResponse.statusCode).to.equal(200)
    expect(readResponse.result[routeLabel]._cached).to.equal(true)
    expect(readResponse.result[routeLabel].label).to.equal(routeLabel)
    expect(readResponse.result[routeLabel].startTime).to.exist()
    expect(readResponse.result[routeLabel].endTime).to.exist()
  })

  lab.test("lite route retrieval", async function () {
    const readResponse = await server.inject({
      method: "GET",
      url: "/routes/lite?label=" + routeLabel,
    })
    expect(readResponse.statusCode).to.equal(200)
    expect(readResponse.result[routeLabel].label).to.equal(routeLabel)
    expect(readResponse.result[routeLabel].startTime).to.exist()
    expect(readResponse.result[routeLabel].endTime).to.exist()
  })

  // lite subscriptions
  lab.test("lite route subscriptions CRUD", async function () {
    let user = userInstance
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

    const getLiteRoutesWithSubsResponse = await server.inject({
      method: "GET",
      url: "/routes/lite",
      headers,
    })
    expect(getLiteRoutesWithSubsResponse.statusCode).to.equal(200)
    expect(getLiteRoutesWithSubsResponse.result[routeLabel].isSubscribed).to.equal(true)
    expect(getLiteRoutesWithSubsResponse.result[routeLabel].label).to.equal(routeLabel)

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

    const getLiteRoutesWithoutSubsResponse = await server.inject({
      method: "GET",
      url: "/routes/lite",
      headers,
    })
    expect(getLiteRoutesWithoutSubsResponse.statusCode).to.equal(200)
    expect(getLiteRoutesWithoutSubsResponse.result[routeLabel].isSubscribed).to.equal(false)
    expect(getLiteRoutesWithoutSubsResponse.result[routeLabel].label).to.equal(routeLabel)
  })

})
