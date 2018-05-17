/* eslint no-await-in-loop: 0 */

let Lab = require("lab")
let lab = exports.lab = Lab.script()

import _ from 'lodash'
const {expect} = require("code")
let server = require("../src/index.js")

const {prepareTicketSale} = require('../src/lib/transactions')
const {randomSingaporeLngLat, randomString, createStripeToken} = require("./test_common")
const {db, models} = require("../src/lib/core/dbschema")()

import {loginAs} from './test_common'

const testMerchantId = process.env.STRIPE_TEST_DESTINATION

lab.experiment("Transactions", function () {
  let testInstances = []
  let stopInstances
  let tripInstances
  let companyInstance1
  let companyInstance2
  let routeInstance1
  let routeInstance2

  /** Additional tests we may/will want to carry out:
        - Test that booking window works
        - ...
  **/

  lab.before({timeout: 10000}, async () => {
    let tripIncludes = {
      include: [{model: models.TripStop }],
    }

    let user = await models.User.create({
      email: "testuser1" + new Date().getTime() +
                "@testtestexample.com",
      name: "Test use r r r r",
      telephone: Date.now(),
    })
    testInstances.push(user)

    companyInstance1 = await models.TransportCompany.create({
      name: "Test company 1",
      clientId: testMerchantId,
      sandboxId: testMerchantId,
    })
    testInstances.push(companyInstance1)

    companyInstance2 = await models.TransportCompany.create({
      name: "Test company 2",
      clientId: testMerchantId,
      sandboxId: testMerchantId,
    })
    testInstances.push(companyInstance2)

    // Create stops
    stopInstances = await Promise.all(
      _.range(0, 8)
        .map((i) => models.Stop.create({
          description: `Test Stop ${i}`,
          coordinates: {
            type: "Point",
            coordinates: randomSingaporeLngLat(),
          },
        }))
    )
    testInstances = testInstances.concat(stopInstances)

    // create Route
    routeInstance1 = await models.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To",
      transportCompanyId: companyInstance1.id,
    })
    routeInstance2 = await models.Route.create({
      name: "Test route only",
      from: "Test route From",
      to: "Test route To",
      transportCompanyId: companyInstance2.id,
    })
    testInstances.push(routeInstance1, routeInstance2)

    // create some trips...
    // assign them to different companies
    tripInstances = await Promise.all(
      _.range(0, 9).map((i) => models.Trip.create({
        // decreasing, to check for ordering
        date: `2020-03-0${9 - i}`,
        capacity: 10,
        routeId: i % 2 ? routeInstance2.id : routeInstance1.id,
        price: (Math.random() * 3 + 3).toFixed(2),
        tripStops: [
          { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: `2020-03-0${9 - i}T08:30:00Z`},
          { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: `2020-03-0${9 - i}T08:35:00Z`},
          { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: `2020-03-0${9 - i}T08:40:00Z`},

          { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: `2020-03-0${9 - i}T09:50:00Z`},
          { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: `2020-03-0${9 - i}T09:55:00Z`},
        ],
      }, tripIncludes))
    )
    testInstances = testInstances.concat(tripInstances)

    let loginResponse = await loginAs("user", user.id)
    expect(loginResponse.statusCode).to.equal(200)
  })

  lab.after(async () => {
    await models.RoutePass.destroy({ truncate: true })
    for (let i = testInstances.length - 1; i >= 0; i--) {
      testInstances[i] = await testInstances[i].destroy()
    }
  })

  const destroyTicketsIn = async txn => {
    for (let txnItem of txn.transactionItems) {
      if (txnItem.itemType.startsWith("ticket")) {
        let ticketId = txnItem.itemId
        await models.Ticket.destroy({
          where: {
            id: ticketId,
          },
        })
      }
    }
  }

  lab.test("Admin's transactions show only his company's", async function () {
    // create the users
    let [user1, user2] = await Promise.all([
      models.User.create({
        name: 'test user 1',
      }),
      models.User.create({
        name: 'test user 2',
      }),
    ])

    // purchase the tickets...
    let [txn1] = await prepareTicketSale([db, models], {
      trips: [
        {
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          userId: user1.id,
        },
        {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          userId: user1.id,
        },
        {
          tripId: tripInstances[4].id,
          boardStopId: tripInstances[4].tripStops[0].id,
          alightStopId: tripInstances[4].tripStops[0].id,
          userId: user1.id,
        },
      ],
      creator: {
        type: 'superadmin',
        id: 0,
      },
      committed: true,
    })
    let [txn2] = await prepareTicketSale([db, models], {
      trips: [
        {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          userId: user2.id,
        },
        {
          tripId: tripInstances[3].id,
          boardStopId: tripInstances[3].tripStops[0].id,
          alightStopId: tripInstances[3].tripStops[0].id,
          userId: user2.id,
        },
        {
          tripId: tripInstances[5].id,
          boardStopId: tripInstances[5].tripStops[0].id,
          alightStopId: tripInstances[5].tripStops[0].id,
          userId: user2.id,
        },
      ],
      creator: {
        type: 'superadmin',
        id: 0,
      },
      committed: true,
    })

    // pull the transaction history as an admin
    let admin1Auth = (await loginAs('admin', {
      transportCompanyId: companyInstance1.id,
      permissions: ['view-transactions'],
    })).result.sessionToken

    let txnHistory1Response = await server.inject({
      method: 'GET',
      url: '/transactions',
      headers: {
        authorization: `Bearer ${admin1Auth}`,
      },
    })
    expect(txnHistory1Response.statusCode).to.equal(200)

    let txnHistory1 = txnHistory1Response.result
    expect(txnHistory1.transactions).to.be.an.array()

    // the first transaction are trips involving company1
    // so it should be in, but not the second transactions
    expect(txnHistory1.transactions.map(txn => txn.id)).to.include(txn1.id)
    expect(txnHistory1.transactions.map(txn => txn.id)).to.not.include(txn2.id)

    // Transaction items test
    await (async () => {
      let txnItems1Response = await server.inject({
        method: 'GET',
        url: `/transaction_items?orderBy=createdAt&order=desc&perPage=100&endDate=${Date.now()}`,
        headers: {
          authorization: `Bearer ${admin1Auth}`,
        },
      })
      expect(txnItems1Response.statusCode).to.equal(200)

      let txnItems1 = txnItems1Response.result.rows
      expect(txnItems1).to.be.an.array()

      // the first transaction are trips involving company1
      // so it should be in, but not the second transactions
      expect(txnItems1.map(txn => txn.transactionId)).to.include(txn1.id)
      expect(txnItems1.map(txn => txn.transactionId)).to.not.include(txn2.id)
    })()

    // pull as superadmin -- both transactions should exist
    let superAdminAuth = (await loginAs('superadmin')).result.sessionToken

    let txnHistoryResponse = await server.inject({
      method: 'GET',
      url: '/transactions',
      headers: {
        authorization: `Bearer ${superAdminAuth}`,
      },
    })
    expect(txnHistoryResponse.statusCode).to.equal(200)
    let txnHistory = txnHistoryResponse.result

    expect(txnHistory.transactions).to.be.an.array()

    // check for both transactions
    expect(txnHistory.transactions.map(txn => txn.id)).to.include(txn1.id)
    expect(txnHistory.transactions.map(txn => txn.id)).to.include(txn2.id)

    // checks for users
    let user1Login = (await loginAs('user', user1.id)).result.sessionToken
    let user2Login = (await loginAs('user', user2.id)).result.sessionToken

    let user1History = (await server.inject({
      method: 'GET',
      url: '/transactions/user_history',
      headers: {
        authorization: `Bearer ${user1Login}`,
      },
    })).result
    expect(user1History.transactions.map(txn => txn.id)).to.include(txn1.id)
    expect(user1History.transactions.map(txn => txn.id)).to.not.include(txn2.id)

    let user2History = (await server.inject({
      method: 'GET',
      url: '/transactions/user_history',
      headers: {
        authorization: `Bearer ${user2Login}`,
      },
    })).result
    expect(user2History.transactions.map(txn => txn.id)).to.include(txn2.id)
    expect(user2History.transactions.map(txn => txn.id)).to.not.include(txn1.id)

    // cleanup
    await destroyTicketsIn(txn1)
    await destroyTicketsIn(txn2)

    await models.Transaction.destroy({ where: {id: {$in: [txn1.id, txn2.id]}} })
  })

  lab.test("Ticket sale and refund appear", {timeout: 20000}, async function () {
    // create the users
    const user = await models.User.create({name: 'test user 1'})

    const admin = await models.Admin.create({
      email: `testadmin${new Date().getTime()}@example.com`,
    })
    await admin.addTransportCompany(companyInstance2.id, {
      permissions: ['refund', 'issue-tickets', 'view-transactions', 'view-passengers'],
    })

    // purchase the ticket...
    const saleResponse = await server.inject({
      method: 'POST',
      url: '/transactions/tickets/payment',
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${user.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)
    const saleTxn = saleResponse.result

    const ticketId = saleTxn.transactionItems.find(i => i.itemType === 'ticketSale').itemId
    const targetAmt = tripInstances[1].priceF

    const refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticketId}/refund/payment`,
      payload: { targetAmt },
      headers: {
        authorization: `Bearer ${admin.makeToken()}`,
      },
    })
    expect(refundResponse.statusCode).to.equal(200)
    const refundTxn = refundResponse.result

    let user1History = (await server.inject({
      method: 'GET',
      url: '/transactions/user_history?groupItemsByType=true',
      headers: {
        authorization: `Bearer ${user.makeToken()}`,
      },
    })).result
    expect(user1History.transactions.map(txn => txn.id)).to.include(saleTxn.id)
    expect(user1History.transactions.map(txn => txn.id)).to.include(refundTxn.id)

    const saleItems = user1History.transactions.find(txn => txn.id === saleTxn.id).itemsByType
    expect(saleItems.ticketSale).exist()
    expect(saleItems.deal).exist()

    const refundItems = user1History.transactions.find(txn => txn.id === refundTxn.id).itemsByType
    expect(refundItems.ticketRefund).exist()
    expect(refundItems.deal).exist()

    await destroyTicketsIn(saleTxn)
  })

  lab.test("Route pass sale and refund appear", {timeout: 20000}, async function () {
    // create the users
    const user = await models.User.create({name: 'test user 1'})

    const admin = await models.Admin.create({
      email: `testadmin${new Date().getTime()}@example.com`,
    })
    await admin.addTransportCompany(companyInstance2.id, {
      permissions: ['refund', 'issue-tickets', 'view-transactions', 'view-passengers'],
    })
    const tag = 'rp-' + randomString()
    await routeInstance2.update({ tags: [tag] })

    // purchase the ticket...
    const saleResponse = await server.inject({
      method: 'POST',
      url: '/transactions/route_passes/payment',
      payload: {
        quantity: 1,
        tag,
        companyId: companyInstance2.id,
        stripeToken: await createStripeToken(),
      },
      headers: {
        authorization: `Bearer ${user.makeToken()}`,
      },
    })
    expect(saleResponse.statusCode).to.equal(200)
    const saleTxn = saleResponse.result

    const {id: transactionItemId, itemId: routePassId} = saleTxn.transactionItems.find(i => i.itemType === 'routePass')

    const refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/route_passes/${routePassId}/refund/payment`,
      payload: { transactionItemId },
      headers: {
        authorization: `Bearer ${admin.makeToken()}`,
      },
    })
    expect(refundResponse.statusCode).to.equal(200)
    const refundTxn = refundResponse.result

    let user1History = (await server.inject({
      method: 'GET',
      url: '/transactions/user_history?groupItemsByType=true',
      headers: {
        authorization: `Bearer ${user.makeToken()}`,
      },
    })).result
    expect(user1History.transactions.map(txn => txn.id)).to.include(saleTxn.id)
    expect(user1History.transactions.map(txn => txn.id)).to.include(refundTxn.id)

    const saleItems = user1History.transactions.find(txn => txn.id === saleTxn.id).itemsByType
    expect(saleItems.routePass).exist()
    expect(saleItems.deal).exist()

    const refundItems = user1History.transactions.find(txn => txn.id === refundTxn.id).itemsByType
    expect(refundItems.routePass).exist()
    expect(refundItems.routePass[0].routePass.route).exist()
    expect(refundItems.deal).exist()
    expect(refundItems.refundPayment).exist()
    expect(refundItems.refundPayment[0].originalChargeData).exist()

    for (let txnItem of saleTxn.transactionItems) {
      if (txnItem.itemType.startsWith("routePass")) {
        await models.RoutePass.destroy({
          where: {
            id: txnItem.itemId,
          },
        })
      }
    }
  })
})
