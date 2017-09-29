import Lab from 'lab'
export const lab = Lab.script()

import {expect, fail} from 'code'

import * as testData from './test_data'

const {models} = require("../src/lib/core/dbschema")()

const expireStaleRoutePasses = require("../src/lib/aws/expireStaleRoutePasses")

lab.experiment("expireStaleRoutePasses", function () {
  let userInstance
  let companyInstance
  let routePassInstance
  let routePassPurchaseItem

  lab.before({timeout: 15000}, async () => {
    ({userInstance, companyInstance} =
      await testData.createUsersCompaniesRoutesAndTrips(models))
    routePassInstance = await models.RoutePass.create({
      userId: userInstance.id, companyId: companyInstance.id, tag: 'rp-101', status: 'valid', notes: { price: 10 }
    })
    routePassPurchaseItem = await models.TransactionItem.create({
      itemType: 'routePass',
      itemid: routePassInstance.id,
      debit: -10
    })
  })

  lab.after({timeout: 10000}, async () => {
    await routePassPurchaseItem.destroy()
    await models.RoutePass.destroy({ truncate: true })
  })

  lab.beforeEach({timeout: 10000}, async () => {
    await routePassInstance.update({ status: 'valid' })
  })

  lab.test("Route pass with fresh date remains untouched", {timeout: 10000}, async () => {
    await expireStaleRoutePasses.handler(undefined, undefined, err => {
      if (err) {
        fail(err)
      }
    })
    await routePassInstance.reload()
    expect(routePassInstance.status).equal('valid')
  })

  lab.test("Route pass with stale date is expired", {timeout: 10000}, async () => {
    await routePassInstance.update({ expiresAt: new Date(new Date().getTime() - 24 * 3600 * 1000) })
    await expireStaleRoutePasses.handler(undefined, undefined, err => {
      if (err) {
        fail(err)
      }
    })
    await routePassInstance.reload()
    expect(routePassInstance.status).equal('expired')
  })
})
