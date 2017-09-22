const Lab = require("lab")
const lab = exports.lab = Lab.script()

const {expect} = require("code")
const server = require("../src/index.js")
const _ = require("lodash")

const {roundToNearestCent} = require("../src/lib/util/common")
const {randomSingaporeLngLat, loginAs, randomEmail, randomString} = require("./test_common")
const {db, models} = require("../src/lib/core/dbschema")()
const Payment = require("../src/lib/transactions/payment")
const {cleanlyDeleteUsers, resetTripInstances, createStripeToken: createStripeTokenRaw} = require("./test_common")

const stripe = Payment.stripe
const sinon = require('sinon')

const testMerchantId = process.env.STRIPE_TEST_DESTINATION
import {
  TransactionError, validateTxn, checkValidTrips,
  checkValidTripStop, checkValidBookingWindow, checkNoDuplicates,
} from "../src/lib/transactions"
import { TransactionBuilder } from '../src/lib/transactions/builder'

lab.experiment("Transactions", function () {
  var userInstance
  var adminInstance
  var authHeaders = {}
  var stripeTokens = []
  var creditTag

  // var testName = "Name for Testing";
  // var updatedTestName = "Updated name for Testing";

  var companyInstance
  var routeInstance
  var stopInstances = []
  var tripInstances = []

  var sandbox

  function verifyCleanTransactionItems (txnItems) {
    var transactionItemTypes = [
      'payment',
      'refundPayment',
      'transfer',
      'account',
      'ticketSale',
      'ticketRefund',
      'ticketExpense'
    ]

    for (let item of txnItems) {
      expect(transactionItemTypes.indexOf(item.itemType)).not.equal(-1)

      for (let itemType of transactionItemTypes) {
        if (item.itemType !== itemType) {
          expect(item).to.not.include(itemType)
        }
      }
    }
  }

  function cleanUpTransaction (transaction) {
    return Promise.all((transaction.transactionItems || [])
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(txnItem => models.Ticket.destroy({where: {id: txnItem.itemId}}))
    ).then(() => models.Transaction.destroy({where: {id: transaction.id}}))
  }

  // Cache this for performance reasons
  const createStripeToken = async () => stripeTokens.length
    ? stripeTokens.shift().id : createStripeTokenRaw()

  const routePassCount = async where => {
    const routePassInstances = await models.RoutePass.findAll({where})
    return routePassInstances.length
  }


  const saveCustomerInfo = async function () {
    var stripeToken = await createStripeToken()
    var customerInfo = await stripe.customers.create({
      source: stripeToken,
      metadata: {
        userId: userInstance.id
      }
    })
    return await stripe.customers.retrieve(customerInfo.id)
  }

  lab.before({timeout: 25000}, async () => {
    creditTag = 'crowdstart-' + randomString()

    userInstance = await models.User.create({
      email: `testuser${new Date().getTime()}@example.com`,
      name: "Test user",
      telephone: Date.now(),
    })

    companyInstance = await models.TransportCompany.create({
      name: "Test company",
      clientId: testMerchantId,
      sandboxId: testMerchantId
    })

    adminInstance = await models.Admin.create({
      email: `testadmin${new Date().getTime()}@example.com`,
    })
    await adminInstance.addTransportCompany(companyInstance.id, {
      permissions: ['refund', 'issue-tickets', 'view-transactions', 'view-passengers']
    })

    // Create stops
    stopInstances = await Promise.all(
      _.range(0, 8).map((i) => models.Stop.create({
        description: `Test Stop ${i + 1}`,
        coordinates: {
          type: "Point",
          coordinates: randomSingaporeLngLat()
        }
      }))
    )

    // create Route
    routeInstance = await models.Route.create({
      name: "Test route only",
      from: "FromHere",
      to: "ToHere",
      tags: [creditTag, 'public'],
      transportCompanyId: companyInstance.id
    })

    // create some trips...
    tripInstances = await Promise.all(
      _.range(0, 9).map((i) => models.Trip.create({
        // decreasing, to check for ordering
        date: `2018-03-0${9 - i}`,
        capacity: 10,
        seatsAvailable: 10,
        routeId: routeInstance.id,
        price: (Math.random() * 3 + 4).toFixed(2),
        tripStops: [
          { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: `2018-03-0${9 - i}T08:30:00Z`},
          { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: `2018-03-0${9 - i}T08:35:00Z`},
          { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: `2018-03-0${9 - i}T08:40:00Z`},

          { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: `2018-03-0${9 - i}T09:50:00Z`},
          { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: `2018-03-0${9 - i}T09:55:00Z`}
        ],
        bookingInfo: {
          windowType: 'stop',
          windowSize: 0,
        }
      }, {
        include: [{model: models.TripStop}]
      }))
    )

    var userToken = userInstance.makeToken()
    authHeaders.user = {authorization: "Bearer " + userToken}

    var adminToken = adminInstance.makeToken()
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    var superToken = (await loginAs("superadmin")).result.sessionToken
    authHeaders.super = {authorization: "Bearer " + superToken}

    // Create 5 Stripe tokens
    stripeTokens = await Promise.all(_.range(0).map(() => createStripeTokenRaw()))
  })

  lab.after({timeout: 10000}, async () => {
    await Promise.all(tripInstances.map(instance => instance.destroy()))
    await Promise.all(stopInstances.map(instance => instance.destroy()))
    await routeInstance.destroy()
    await models.RoutePass.destroy({ truncate: true })
    await companyInstance.destroy()
    await cleanlyDeleteUsers({id: userInstance.id})
    await adminInstance.destroy()
  })

  lab.beforeEach(async () => {
    sandbox = sinon.sandbox.create()
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get "user already has ticket" errors, or unexpected
    capacity errors
  */
  lab.afterEach(async () => {
    sinon.sandbox.restore()
    await resetTripInstances(models, tripInstances)
    await models.RoutePass.destroy({ truncate: true })
  })

  lab.test("Prepare transaction", async function () {
    // CREATE
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }]
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    verifyCleanTransactionItems(saleResponse.result.transactionItems)

    var items = _.groupBy(saleResponse.result.transactionItems, "itemType")

    expect(items.ticketSale.length).to.equal(3)
    expect(items.payment.length).to.equal(1)
    expect(items.transfer.length).to.equal(1)

    // payment (to Beeline) matches total price of tickets
    var totalPrice =
      parseFloat(tripInstances[0].price) +
      parseFloat(tripInstances[1].price) +
      parseFloat(tripInstances[2].price)
    expect(parseFloat(items.payment[0].debit).toFixed(2))
      .to.equal(totalPrice.toFixed(2))

    // transfer (to operator) matches COGS
    expect(parseFloat(items.transfer[0].credit).toFixed(2))
      .to.equal(parseFloat(items.account[0].debit).toFixed(2))

    // transferred to the correct operator
    expect(items.transfer[0].transfer.transportCompanyId)
      .to.equal(companyInstance.id)

    await cleanUpTransaction(saleResponse.result)
  })

  lab.test("Trips are sorted in correct order", async function () {
    // CREATE

    var ticketData = [{
      tripId: tripInstances[0].id,
      boardStopId: tripInstances[0].tripStops[0].id,
      alightStopId: tripInstances[0].tripStops[0].id,
      // qty: 1
    }, {
      tripId: tripInstances[1].id,
      boardStopId: tripInstances[1].tripStops[0].id,
      alightStopId: tripInstances[1].tripStops[0].id,
      // qty: 1
    }, {
      tripId: tripInstances[1].id,
      boardStopId: tripInstances[1].tripStops[1].id,
      alightStopId: tripInstances[1].tripStops[2].id,
      // qty: 1
    }, {
      tripId: tripInstances[1].id,
      boardStopId: tripInstances[1].tripStops[0].id,
      alightStopId: tripInstances[1].tripStops[2].id,
      // qty: 1
    }, {
      tripId: tripInstances[2].id,
      boardStopId: tripInstances[2].tripStops[0].id,
      alightStopId: tripInstances[2].tripStops[0].id,
      // qty: 1
    }]

    await Promise.all(ticketData.map(td => models.Ticket.create({
      userId: userInstance.id,
      boardStopId: td.boardStopId,
      alightStopId: td.alightStopId,
      status: 'valid'
    })))

    // pull tickets
    var tickets = (await server.inject({
      method: "GET",
      url: "/tickets?startTime=" + encodeURIComponent(
        _.min(tripInstances.map(ti => ti.date.getTime()))
      ),
      headers: authHeaders.admin
    })).result

    for (let i = 0; i < tickets.length - 2; i++) {
      expect(tickets[i].boardStop.time)
        .to.be.below(tickets[i + 1].boardStop.time)
    }
  })

  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("Payment works", {timeout: 15000}, async function () {
    // Inject the ticket purchases
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken()
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    verifyCleanTransactionItems(saleResponse.result.transactionItems)

    var tripPrice = parseFloat(tripInstances[1].price)

    // Check that the card was debited correctly
    var items = _.groupBy(saleResponse.result.transactionItems, "itemType")
    expect(parseFloat(items.payment[0].debit).toFixed(2))
      .to.equal(tripPrice.toFixed(2))
    expect(items.payment[0].payment.data).to.exist()
    expect(parseFloat(items.payment[0].payment.data.amount))
      .to.equal(Math.round(100 * tripPrice))

    // correct application fee applied
    var processingFee = (await Payment.retrieveTransaction(
      items.payment[0].payment.data.balance_transaction)).fee
    var expectedProcessingFee =
      Math.round(tripPrice * 100 * parseFloat(process.env.STRIPE_MICRO_CHARGE_RATE)) +
      parseInt(process.env.STRIPE_MICRO_MIN_CHARGE)

    expect(processingFee)
      .to.equal(expectedProcessingFee)

    var ticketId = items.ticketSale[0].itemId
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticketId}/refund/payment`,
      payload: {
        targetAmt: tripPrice,
      },
      headers: authHeaders.admin,
    })
    expect(refundResponse.statusCode).to.equal(200)

    verifyCleanTransactionItems(refundResponse.result.transactionItems)

    items = _.groupBy(refundResponse.result.transactionItems, "itemType")
    expect(parseFloat(items.refundPayment[0].credit).toFixed(2))
      .to.equal(tripPrice.toFixed(2))
    expect(items.refundPayment[0].refundPayment.data).to.exist()
    expect(parseFloat(items.refundPayment[0].refundPayment.data.amount))

    var refundedTicket = await models.Ticket.findById(ticketId)
    expect(refundedTicket.status).equal('refunded')

    await cleanUpTransaction(refundResponse.result)
    await cleanUpTransaction(saleResponse.result)
  })


  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("Cannot book cancelled trip", {timeout: 15000}, async function () {
    var error
    try {
      await tripInstances[1].update({
        status: 'cancelled'
      })

      // Inject the ticket purchases
      var saleResponse = await server.inject({
        method: "POST",
        url: "/transactions/tickets/payment",
        payload: {
          trips: [{
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            // qty: 1
          }],
          stripeToken: await createStripeToken()
        },
        headers: authHeaders.user
      })
      expect(saleResponse.statusCode).equal(400)
      expect(saleResponse.result.message).contains('cancelled')

      await tripInstances[1].update({
        status: 'void'
      })

      // Inject the ticket purchases
      saleResponse = await server.inject({
        method: "POST",
        url: "/transactions/tickets/payment",
        payload: {
          trips: [{
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            // qty: 1
          }],
          stripeToken: await createStripeToken()
        },
        headers: authHeaders.user
      })
      expect(saleResponse.statusCode).equal(400)
      expect(saleResponse.result.message).contains('cancelled')
    } catch (err) {
      error = err
    } finally {
      await tripInstances[1].update({
        status: null
      })
    }

    if (error) throw error
  })

  lab.test("Trip capacity", {timeout: 15000}, async function () {
    // create 11 fake users
    var time = new Date().getTime()

    var fakeUsers = await Promise.all(_.range(0, 11)
      .map(i => models.User.create({
        name: `Some user ${i}`,
        email: "test-user-" + (time + i) + "@example.com"
      }))
    )

    var oneLastUser = fakeUsers.pop()

    // Inject the first 10 ticket purchases
    for (let user of fakeUsers) {
      await models.Ticket.create({ // eslint-disable-line no-await-in-loop
        userId: user.id,
        boardStopId: tripInstances[1].tripStops[0].id,
        alightStopId: tripInstances[1].tripStops[0].id,
        status: 'valid'
      })
    }

    // add one more
    fakeUsers.push(oneLastUser)
    const fakeSale = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
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
        authorization: "Bearer " + oneLastUser.makeToken()
      }
    })

    expect(fakeSale.statusCode).to.equal(400)

    await cleanUpTransaction(fakeSale.result)
    await models.Ticket.destroy({
      where: {userId: {$in: fakeUsers.map(u => u.id)}}
    })
    await Promise.all(
      fakeUsers.map(user => cleanlyDeleteUsers({ telephone: user.telephone }))
    )
  })

  lab.test("Dry run price checks have no effect on DB", async () => {
    // Count the # transactions before, after
    var numTransactionsBefore = await models.Transaction.count()
    var numTicketsBefore = await models.Ticket.count()

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }]
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    // Count the # transactions before, after
    var numTransactionsAfter = await models.Transaction.count()
    var numTicketsAfter = await models.Ticket.count()

    expect(numTransactionsAfter).equal(numTransactionsBefore)
    expect(numTicketsAfter).equal(numTicketsBefore)

    await cleanUpTransaction(saleResponse.result)
  })

  // CREATE
  lab.test("Passenger appears on passenger list", {timeout: 15000}, async () => {
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    // update transaction to committed
    // and ticket status to valid
    var transaction = await models.Transaction.findById(
      saleResponse.result.id, {include: [models.TransactionItem]}
    )
    transaction.committed = true
    await transaction.save()

    await Promise.all(transaction.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        let ticket = await models.Ticket.findById(txnItem.itemId)
        ticket.status = "valid"
        return ticket.save()
      })
    )

    var passengerList = (await server.inject({
      method: "GET",
      url: "/trips/" + tripInstances[1].id + "/passengers",
      headers: authHeaders.admin
    })).result.map(passenger => passenger.id)

    // ensure that this user is listed in the list of passengers
    expect(passengerList).to.include(userInstance.id)

    await cleanUpTransaction(saleResponse.result)
  })

  const issueFreeRoutePassWorksFor = role => async () => {
    var response = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: creditTag
      },
      headers: authHeaders[role],
    })
    expect(response.statusCode).to.equal(200)

    let transactionItemsByType = _.groupBy(response.result.transactionItems, ti => ti.itemType)
    expect(_.keys(transactionItemsByType).length).equal(2)

    expect(transactionItemsByType.routePass).exist()
    expect(transactionItemsByType.routePass.length).equal(1)

    expect(transactionItemsByType.account).exist()
    expect(transactionItemsByType.account.length).equal(1)

    const routePassInst = await models.RoutePass.findById(transactionItemsByType.routePass[0].itemId)
    expect(routePassInst).exist()
  }

  lab.test("Issue Free Route Pass - is working for superAdmin", {timeout: 15000}, issueFreeRoutePassWorksFor('super'))

  lab.test("Issue Free Route Pass - is working for admin", {timeout: 15000}, issueFreeRoutePassWorksFor('admin'))

  const issueFreeRoutePassFailsFor = role => async () => {
    const where = { userId: userInstance.id, companyId: companyInstance.id, tag: creditTag}
    const initialRoutePassCount = await routePassCount(where)

    var response = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: creditTag
      },
      headers: typeof role === 'string' ? authHeaders[role] : role,
    })
    expect(response.statusCode).to.equal(403)

    expect(await routePassCount(where)).equal(initialRoutePassCount)
  }

  lab.test("Issue Free Route Pass - admin is checked for company affiliation", {timeout: 15000}, async function () {
    let otherCompanyInstance = await models.TransportCompany.create({
      name: "Test company 2",
      clientId: testMerchantId,
      sandboxId: testMerchantId
    })

    let otherAdminInstance = await models.Admin.create({
      email: `testadmin2${new Date().getTime()}@example.com`,
    })
    await otherAdminInstance.addTransportCompany(otherCompanyInstance.id, {
      permissions: ['refund', 'issue-tickets', 'view-transactions', 'view-passengers']
    })

    let otherAdminToken = otherAdminInstance.makeToken()
    let otherAdminAuth = {authorization: "Bearer " + otherAdminToken}
    await issueFreeRoutePassFailsFor(otherAdminAuth)()
  })

  lab.test("Issue Free Route Pass - fails for normal users", {timeout: 15000}, issueFreeRoutePassFailsFor('user'))

  lab.test("Issue Free Route Pass - fails for not logged in", {timeout: 15000}, issueFreeRoutePassFailsFor('public'))

  lab.test("Admins cannot issue tickets from other companies", async function () {
    const adminInst = await models.Admin.create({
      email: randomEmail()
    })
    const request = {
      method: "POST",
      url: "/transactions/tickets/issue_free",
      payload: {
        description: 'Free ticket issued',
        trips: [
          {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[0].id,
            userId: userInstance.id,
          }
        ]
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`
      }
    }

    // Issue a free ticket to this user...
    var issueResponse = await server.inject(request)
    expect(issueResponse.statusCode).to.equal(403)

    // Try to issue again, this time with the correct permissions
    await adminInst.addTransportCompany(companyInstance.id, {
      permissions: ['issue-tickets']
    })

    var issueResponse2 = await server.inject(request)
    expect(issueResponse2.statusCode).to.equal(200)

    // Try to cancel
    // without the correct permissions
    await adminInst.setTransportCompanies([companyInstance.id], {
      permissions: []
    })

    const cancelRequest = {
      method: "POST",
      url: "/transactions/tickets/issue_free",
      payload: {
        description: 'Free ticket issued',
        trips: [{
          tripId: tripInstances[3].id,
          boardStopId: tripInstances[3].tripStops[0].id,
          alightStopId: tripInstances[3].tripStops[0].id,
          userId: userInstance.id,
        }]
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`
      }
    }
    const cancelResponse1 = await server.inject(cancelRequest)
    expect(cancelResponse1.statusCode).to.equal(403)

    // and again with the correct permissions
    await adminInst.setTransportCompanies([companyInstance.id], {
      permissions: ['issue-tickets']
    })
    const cancelResponse2 = await server.inject(cancelRequest)
    expect(cancelResponse2.statusCode).to.equal(200)
  })

  lab.test("Free ticket", async function () {
    await tripInstances[0].reload()
    await tripInstances[1].reload()
    await tripInstances[2].reload()
    // Issue a free ticket to this user...
    var issueResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/issue_free",
      payload: {
        description: 'Free ticket issued',
        trips: [
          {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[0].id,
            userId: userInstance.id,
          }
        ]
      },
      headers: authHeaders.admin
    })
    expect(issueResponse.statusCode).to.equal(200)

    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity - 1)
    await tripInstances[1].reload()
    expect(tripInstances[1].seatsAvailable).equal(tripInstances[1].capacity - 1)
    await tripInstances[2].reload()
    expect(tripInstances[2].seatsAvailable).equal(tripInstances[2].capacity - 1)

    verifyCleanTransactionItems(issueResponse.result.transactionItems)

    var ticketExpenseItems = issueResponse.result.transactionItems
      .filter(txnItem => txnItem.ticketExpense)

    // All trips should appear
    expect(ticketExpenseItems.findIndex(
      txnItem => txnItem.ticketExpense.boardStopId === tripInstances[0].tripStops[0].id
    )).to.not.equal(-1)
    expect(ticketExpenseItems.findIndex(
      txnItem => txnItem.ticketExpense.boardStopId === tripInstances[1].tripStops[0].id
    )).to.not.equal(-1)
    expect(ticketExpenseItems.findIndex(
      txnItem => txnItem.ticketExpense.boardStopId === tripInstances[2].tripStops[0].id
    )).to.not.equal(-1)
    // only three tickets should exist
    expect(ticketExpenseItems.length).to.equal(3)

    // transactions should be committed
    expect(issueResponse.result.committed).to.equal(true)
    // tickets should be valid
    for (let txnItem of ticketExpenseItems) {
      expect(txnItem.ticketExpense.status).to.equal("valid")
    }
    // admin
    expect(issueResponse.result.creatorType).to.equal('admin')
    expect(issueResponse.result.creatorId).to.equal(adminInstance.id.toString())

    await cleanUpTransaction(issueResponse.result)
  })

  lab.test("Replacement ticket", async function () {
    await tripInstances[0].reload()
    await tripInstances[1].reload()
    await tripInstances[2].reload()

    // Issue a free ticket to this user...
    var issueResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/issue_free",
      payload: {
        description: 'Free ticket issued',
        trips: [
          {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[0].id,
            userId: userInstance.id,
          }
        ]
      },
      headers: authHeaders.admin
    })
    expect(issueResponse.statusCode).to.equal(200)

    verifyCleanTransactionItems(issueResponse.result.transactionItems)

    // Get the ticket ids
    var originalTicketIds = issueResponse.result.transactionItems
      .filter(txnItem => txnItem.ticketExpense)
      .map(txnItem => txnItem.ticketExpense.id)

    // Use them as replacements...
    var replacementResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/issue_free",
      payload: {
        description: 'Replace the previous tickets',
        trips: [
          {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
            userId: userInstance.id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[0].id,
            userId: userInstance.id,
          }
        ],
        cancelledTicketIds: originalTicketIds,
      },
      headers: authHeaders.admin
    })
    expect(replacementResponse.statusCode).to.equal(200)

    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity - 1)
    await tripInstances[1].reload()
    expect(tripInstances[1].seatsAvailable).equal(tripInstances[1].capacity - 1)
    await tripInstances[2].reload()
    expect(tripInstances[2].seatsAvailable).equal(tripInstances[2].capacity - 1)

    verifyCleanTransactionItems(replacementResponse.result.transactionItems)

    // Get the ticket ids
    var newTicketIds = replacementResponse.result.transactionItems
      .filter(txnItem => txnItem.ticketExpense)
      .map(txnItem => txnItem.ticketExpense.id)

    // For the original tickets, ensure thay are "replaced"
    var originalTickets = await models.Ticket.findAll({
      where: {id: {$in: originalTicketIds}}
    })

    for (let ticket of originalTickets) {
      expect(ticket.status).to.equal('void')
    }

    // For the new tickets, ensure they are valid
    var newTickets = await models.Ticket.findAll({
      where: {id: {$in: newTicketIds}}
    })

    for (let ticket of newTickets) {
      expect(ticket.status).to.equal('valid')
    }

    await cleanUpTransaction(replacementResponse.result)
    await cleanUpTransaction(issueResponse.result)
  })

  lab.test("When payment fails it fails cleanly", {timeout: 15000}, async function () {
    // Inject the ticket purchases
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[1].id,
        }],
        stripeToken: 'Fake stripe token!'
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).equal(402)
    // User-readable message
    expect(saleResponse.result.message).to.be.a.string()

    // Find the latest ticket for this user...
    var latestTicket = await models.Ticket.find({
      userId: userInstance.id,
      order: [['createdAt', 'desc']]
    })

    expect(latestTicket.status).equal('failed')

    await tripInstances[2].reload()

    expect(tripInstances[2].seatsAvailable).equal(tripInstances[2].capacity)

    // Find the latest payment
    var latestPayment = await models.Payment.find({
      order: [['createdAt', 'desc']]
    })
    expect(latestPayment.data.message).startsWith('No such token:')

    // Get their associated transaction -- ensure it is not committed
    var transactions = await models.Transaction.findAll({
      include: [
        {
          model: models.TransactionItem,
          where: {itemType: 'ticketSale', itemId: latestTicket.id}
        }
      ]
    })
    expect(transactions.length).equal(1)
    expect(transactions[0].committed).equal(false)

    await cleanUpTransaction(saleResponse.result)
  })
  lab.test("Declined card", {timeout: 15000}, async function () {
    var now = new Date()

    // Inject the ticket purchases
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[1].id,
        }],
        stripeToken: (await Payment.createStripeToken({
          number: "4000000000000341",
          exp_month: "12",
          exp_year: "2020",
          cvc: "123"
        })).id
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).equal(402)
    // User-readable message
    expect(saleResponse.result.message).to.be.a.string()
    expect(saleResponse.result.message.toUpperCase()).contain('DECLINED')

    const latestPayment = await models.Payment.find({
      where: {createdAt: {$gt: now}}
    })

    expect(latestPayment.paymentResource).not.exist()
    expect(latestPayment.data).exist()
    expect(latestPayment.data.message).exist()
  })

  lab.test("validateTxn", (done) => {
    const txn = {}
    const caller = () => { validateTxn(txn) }
    expect(caller).to.throw()
    txn.transactionItems = [
      {itemId: 1, debit: 5},
      {itemId: 2, debit: -2},
      {debit: -3}
    ]
    expect(caller).to.throw()
    txn.transactionItems[2].itemId = 3
    expect(caller).to.not.throw()
    txn.transactionItems[2].debit = -2
    expect(caller).to.throw()
    txn.transactionItems.push({itemId: 4, credit: 1})
    expect(caller).to.not.throw()
    done()
  })

  lab.test("checkValidTripStop", (done) => {
    const dbTrip = {
      id: 12345,
      tripStops: [
        {id: 2},
        {id: 3},
        {id: 4}
      ]
    }
    const rqTrip = {
      boardStopId: 1,
      alightStopId: 5
    }
    const caller = () => { checkValidTripStop(dbTrip, rqTrip) }
    expect(caller).to.throw(TransactionError)
    dbTrip.tripStops.push({id: 1})
    expect(caller).to.throw(TransactionError)
    dbTrip.tripStops.push({id: 5})
    expect(caller).to.not.throw()
    done()
  })

  lab.test("checkValidBookingWindow", (done) => {
    const refDate = new Date(2012, 12, 21, 12).valueOf()
    const dbTrip = {
      id: 12345,
      tripStops: [
        {id: 1, time: {getTime: () => refDate - 2}},
        {id: 2, time: {getTime: () => refDate - 1}},
        {id: 3, time: {getTime: () => refDate + 3}},
      ],
      bookingInfo: {}
    }
    const rqTrip = {
      boardStopId: 2,
      alightStopId: 3
    }
    const caller = () => { checkValidBookingWindow(refDate)(dbTrip, rqTrip) }
    expect(caller).to.throw(TransactionError)
    dbTrip.tripStops[1].time.getTime = () => refDate + 2
    expect(caller).to.not.throw()
    dbTrip.bookingInfo.windowType = 'firstStop'
    expect(caller).to.throw(TransactionError)
    dbTrip.tripStops[0].time.getTime = () => refDate + 1
    expect(caller).to.not.throw()
    done()
  })

  lab.test("checkNoDuplicates", (done) => {
    const dbTrip = {
      tripStops: [{
        id: 1,
        tickets: [{status: 'valid', userId: 'foo'}]
      }]
    }
    const rqTrip = {userId: 'foo'}
    const caller = () => {
      checkNoDuplicates()(dbTrip, rqTrip)
    }
    expect(caller).to.throw(TransactionError)
    dbTrip.tripStops[0].tickets = [{status: 'void', userId: 'foo'}]
    expect(caller).to.not.throw()
    dbTrip.tripStops[0].tickets = [{status: 'valid', userId: 'bar'}]
    expect(caller).to.not.throw()
    done()
  })

  lab.test("checkValidTrips", (done) => {
    const tripsById = {t1: {isRunning: true}, t2: {isRunning: true}, t3: {isRunning: true}, t4: {isRunning: false}}
    const tripsRequested = [
      {tripId: 't1'},
      {tripId: 't2'},
      {tripId: 't3'},
      {tripId: 't4'}
    ]
    let timesCalled = 0
    const checks = [() => { timesCalled++ }]
    const caller = () => { checkValidTrips(tripsById, tripsRequested, checks) }
    expect(caller).to.throw(TransactionError)
    tripsRequested.pop()
    delete tripsById.t4
    timesCalled = 0
    expect(caller).to.not.throw()
    expect(timesCalled).to.equal(3)
    done()
  })

  lab.test("Payment.calculateAdminFeeInCents", (done) => {
    const STRIPE_MICRO_RATES = process.env.STRIPE_MICRO_RATES
    process.env.STRIPE_MICRO_RATES = 'true'
    expect(Payment.calculateAdminFeeInCents(0, true)).to.equal(0)
    expect(Payment.calculateAdminFeeInCents(0, false)).to.equal(0)

    const STRIPE_MICRO_MIN_CHARGE = parseInt(process.env.STRIPE_MICRO_MIN_CHARGE)
    const STRIPE_MACRO_MIN_CHARGE = parseInt(process.env.STRIPE_MACRO_MIN_CHARGE)

    const STRIPE_MICRO_CHARGE_RATE = parseFloat(process.env.STRIPE_MICRO_CHARGE_RATE)
    const STRIPE_LOCAL_CHARGE_RATE = parseFloat(process.env.STRIPE_LOCAL_CHARGE_RATE)
    const STRIPE_AMEXINTL_CHARGE_RATE = parseFloat(process.env.STRIPE_AMEXINTL_CHARGE_RATE)

    expect(Payment.calculateAdminFeeInCents(100, true, false))
      .to.equal(Math.round(100 * STRIPE_MICRO_CHARGE_RATE) + STRIPE_MICRO_MIN_CHARGE)

    expect(Payment.calculateAdminFeeInCents(100, false, false))
      .to.equal(Math.round(100 * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
    expect(Payment.calculateAdminFeeInCents(100, false, true))
      .to.equal(Math.round(100 * STRIPE_LOCAL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)

    expect(Payment.calculateAdminFeeInCents(1000, Payment.isMicro(1000), false))
      .to.equal(Math.round(1000 * STRIPE_MICRO_CHARGE_RATE) + STRIPE_MICRO_MIN_CHARGE)
    expect(Payment.calculateAdminFeeInCents(1000, Payment.isMicro(1000), true))
      .to.equal(Math.round(1000 * STRIPE_MICRO_CHARGE_RATE) + STRIPE_MICRO_MIN_CHARGE)

    expect(Payment.calculateAdminFeeInCents(1001, Payment.isMicro(1001), false))
      .to.equal(Math.round(1001 * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
    expect(Payment.calculateAdminFeeInCents(1001, Payment.isMicro(1001), true))
      .to.equal(Math.round(1001 * STRIPE_LOCAL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)

    // Verify that when we turn micro rates off, we ignore micro rates
    process.env.STRIPE_MICRO_RATES = 'false'
    expect(Payment.calculateAdminFeeInCents(100, true, false))
      .to.equal(Math.round(100 * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
    expect(Payment.calculateAdminFeeInCents(100, true, true))
      .to.equal(Math.round(100 * STRIPE_LOCAL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
    process.env.STRIPE_MICRO_RATES = STRIPE_MICRO_RATES
    done()
  })

  lab.test("Charge from saved CustomerId", {timeout: 15000}, async function () {
    // CREATE a transaction as a user...
    var customerInfo = await saveCustomerInfo()
    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }],
        customerId: customerInfo.id,
        sourceId: customerInfo.sources.data[0].id
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)
    await cleanUpTransaction(saleResponse.result)
  })

  lab.test("Test setting transaction type", {timeout: 15000}, async function () {
    var tbInst
    const txTypes = ["ticketPurchase", "conversion", "refund"]
    const throwable = "Break transaction"

    for (let txType of txTypes) {
      try {
        await db.transaction(async (transaction) => { // eslint-disable-line no-await-in-loop
          var tb = new TransactionBuilder({
            transaction,
            db,
            models,
            dryRun: false,
            committed: true
          });

          [tbInst] = await tb.build({type: txType})

          throw throwable
        })
      } catch (error) {
        expect(error).to.equal(throwable)
        expect(tbInst.type).to.equal(txType)
      }
    }

    try {
      await db.transaction(async (transaction) => {
        var tb = new TransactionBuilder({
          transaction,
          db,
          models,
          dryRun: false,
          committed: true
        });

        // Defaults type to "ticketPurchase" when none provided
        [tbInst] = await tb.build()

        throw throwable
      })
    } catch (error) {
      expect(error).to.equal(throwable)
      expect(tbInst.type).to.equal("ticketPurchase")
    }

    try {
      await db.transaction(async (transaction) => {
        var tb = new TransactionBuilder({
          transaction,
          db,
          models,
          dryRun: false,
          committed: true
        });

        // No such type allowed, error should be thrown
        [tbInst] = await tb.build({type: "asdgasg"})

        throw throwable
      })
    } catch (error) {
      expect(error).to.not.equal(throwable)
      expect(error.name).to.equal("SequelizeValidationError")
    }
  })


  lab.test("Refund Payment and refund limit works", {timeout: 15000}, async function () {
    await tripInstances[0].reload()
    const tripPrice = tripInstances[0].price
    const seatsAvailable = tripInstances[0].seatsAvailable

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken()
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(seatsAvailable - 1)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund a ticket...
    var refundResponse1 = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: tripPrice
      },
      headers: authHeaders.admin
    })

    expect(refundResponse1.statusCode).to.equal(200)

    var refund1TIByType = _.groupBy(refundResponse1.result.transactionItems, ti => ti.itemType)

    expect(_.keys(refund1TIByType).length).equal(4)
    expect(refund1TIByType.refundPayment).exist()
    expect(refund1TIByType.refundPayment.length).equal(1)
    expect(refund1TIByType.refundPayment[0].credit).equal(tripPrice)
    expect(refund1TIByType.refundPayment[0].refundPayment.paymentResource).exist()
    expect(refund1TIByType.refundPayment[0].refundPayment.data).exist()
    expect(refund1TIByType.transfer).exist()
    expect(refund1TIByType.transfer.length).equal(2)
    expect(refund1TIByType.account).exist()
    expect(refund1TIByType.account.length).equal(1)
    expect(refund1TIByType.ticketRefund).exist()
    expect(refund1TIByType.ticketRefund.length).equal(1)
    expect(refund1TIByType.ticketRefund[0].notes).exist()

    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(seatsAvailable)

    // temporary: bypass ticket validity check
    // to verify previous refunds are considered
    await ticket.reload()
    await ticket.update({status: 'valid'})
    await ticket.reload()

    var refundResponse2 = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: tripPrice
      },
      headers: authHeaders.admin
    })

    expect(refundResponse2.statusCode).to.equal(400)
    expect(refundResponse2.result.message).equal('Refund requested causes total refunded to exceed allowed refund amount')

    // Test the undo function
    const stripeInstance = require('../src/lib/transactions/payment').stripe
    sandbox.stub(stripeInstance.refunds, "create", () => Promise.reject({hello: 'world'}))

    var ticket1 = tickets.find(t => t.boardStopId === tripInstances[1].tripStops[0].id)

    // Refund a ticket...
    var refundResponse3 = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket1.id}/refund/payment`,
      payload: {
        targetAmt: tripInstances[1].price
      },
      headers: authHeaders.admin
    })
    expect(refundResponse3.statusCode).equal(402)

    await tripInstances[1].reload()
    expect(tripInstances[1].seatsAvailable).equal(tripInstances[1].capacity - 1)

    await ticket1.reload()
    expect(ticket1.status).equal('valid')

    const failedItems = await models.TransactionItem.findAll({
      where: {
        itemType: 'ticketRefund',
        itemId: ticket1.id
      },
      include: [models.Transaction]
    })
    expect(failedItems.length).equal(1)
    expect(failedItems[0].transaction.committed).false()

    const failedPaymentTI = await models.TransactionItem.findAll({
      where: {
        itemType: 'refundPayment',
        transactionId: failedItems[0].transactionId
      },
    })
    const failedRefundPayment = await models.RefundPayment.findById(failedPaymentTI[0].itemId)
    expect(failedRefundPayment.data.hello).equal('world')
  })

  lab.test("Refund Payment disallowed if payment is less than ticket value", {timeout: 15000}, async function () {
    const tripPrice = tripInstances[0].price

    var creditInst = await models.Credit.create({
      userId: userInstance.id,
      balance: tripPrice - 2,
    })

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
        applyCredits: true
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund ticket at full price
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: tripPrice
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(400)
    await creditInst.destroy()
  })

  lab.test("Refund Payment allowed if payment is more than ticket value", {timeout: 15000}, async function () {
    const tripPrice = tripInstances[0].price
    await models.Credit.destroy({ truncate: true })
    var creditInst = await models.Credit.create({
      userId: userInstance.id,
      balance: tripPrice - 2,
    })

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
        applyCredits: true
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund ticket at full price
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: tripPrice
      },
      headers: authHeaders.admin
    })
    expect(refundResponse.statusCode).to.equal(200)

    var refundTIByType = _.groupBy(refundResponse.result.transactionItems, ti => ti.itemType)

    expect(_.keys(refundTIByType).length).equal(4)
    expect(refundTIByType.refundPayment).exist()
    expect(refundTIByType.refundPayment.length).equal(1)
    expect(refundTIByType.refundPayment[0].credit).equal(tripPrice)

    await creditInst.destroy()
  })

  lab.test("Refund Payment disallowed if targetAmt is less than ticket value", {timeout: 20000}, async function () {
    const tripPrice = tripInstances[0].price

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
        }],
        stripeToken: await createStripeToken(),
        applyCredits: true
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund ticket at less than full price
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/payment`,
      payload: {
        targetAmt: tripPrice - 2
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(400)
    expect(refundResponse.result.message).equal('Current implementation requires requested refund to equal ticket value after discounts')
  })

  lab.test("Refund RoutePass works", {timeout: 15000}, async function () {
    const tripPrice = tripInstances[0].price
    const seatsAvailable = tripInstances[0].seatsAvailable

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken()
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund a ticket...
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
      payload: {
        targetAmt: tripPrice,
        creditTag
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(200)

    var refundTIByType = _.groupBy(refundResponse.result.transactionItems, ti => ti.itemType)

    expect(_.keys(refundTIByType).length).equal(3)
    expect(refundTIByType.routePass).exist()
    expect(refundTIByType.routePass.length).equal(1)
    expect(refundTIByType.routePass[0].itemType).equal('routePass')
    expect(refundTIByType.routePass[0].credit).equal(tripPrice)
    expect(refundTIByType.account).exist()
    expect(refundTIByType.account.length).equal(2)
    expect(refundTIByType.ticketRefund).exist()

    await tripInstances[0].reload()
    expect(seatsAvailable).equal(tripInstances[0].seatsAvailable)

    const routePassInst = await models.RoutePass.findById(refundTIByType.routePass[0].itemId)
    expect(routePassInst.notes.refundedTicketId).equal(ticket.id)

    // temporary: bypass ticket validity check
    // to verify previous refunds are considered
    await ticket.reload()
    await ticket.update({status: 'valid'})
    await ticket.reload()

    var refundResponse2 = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
      payload: {
        targetAmt: tripPrice,
        creditTag
      },
      headers: authHeaders.admin
    })

    expect(refundResponse2.statusCode).to.equal(400)
    expect(refundResponse2.result.message).equal('Unable to refund to routePass for partially refunded tickets')
  })

  lab.test("Refund RoutePass fails for bad creditTags", {timeout: 30000}, async function () {
    const tripPrice = tripInstances[0].price

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken()
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    await tripInstances[0].reload()
    const seatsAvailable = tripInstances[0].seatsAvailable

    const where = {userId: userInstance.id, companyId: companyInstance.id, tag: creditTag}
    const initialRoutePassCount = await routePassCount(where)

    const makeAndValidateBadRefundRequest = async creditTag => {
      var refundResponse = await server.inject({
        method: "POST",
        url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
        payload: { creditTag, targetAmt: tripPrice },
        headers: authHeaders.admin
      })

      expect(refundResponse.statusCode).to.equal(400)

      await tripInstances[0].reload()
      expect(seatsAvailable).equal(tripInstances[0].seatsAvailable)
      expect(await routePassCount(where)).equal(initialRoutePassCount)
    }

    // Irrelevant tag
    await makeAndValidateBadRefundRequest('BADCREDITTAG')
    // Non-credit tags
    await makeAndValidateBadRefundRequest('public')
  })

  lab.test("Refund RoutePass fails if targetAmt is not equal to ticket value", {timeout: 15000}, async function () {
    const tripPrice = tripInstances[0].price

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
        }],
        stripeToken: await createStripeToken(),
        applyCredits: true
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    // Refund ticket at less than full price
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
      payload: {
        targetAmt: tripPrice - 2,
        creditTag
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(400)
    expect(refundResponse.result.message).equal(
      'Route Pass requires refunded amount to be equal to ticket\'s base price'
    )

    refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
      payload: {
        targetAmt: tripPrice + 2,
        creditTag
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(400)
    expect(refundResponse.result.message).equal(
      'Route Pass requires refunded amount to be equal to ticket\'s base price'
    )
  })

  lab.test("Refund RoutePass works for discounted purchases", {timeout: 15000}, async function () {
    const tripPrice = tripInstances[0].price
    const promoCode = randomString()

    let oldPromo = await models.Promotion.find({ where: { code: promoCode }})
    if (oldPromo) {
      await models.PromoUsage.destroy({ where: { promoId: oldPromo.id }})
      await oldPromo.destroy()
    }

    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'Promotion',
      params: {
        qualifyingCriteria: [
          {type: 'noLimit', params: {}},
        ],
        discountFunction: {
          type: "simpleRate",
          params: {"rate": 0.5}
        },
        refundFunction: {
          type: "refundDiscountedAmt"
        },
        usageLimit: {
          globalLimit: 10,
          userLimit: 10
        }
      },
      description: `Test promo ${Date.now()}`
    })

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode, options: {} }
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)

    var tickets = await Promise.all(saleResponse.result.transactionItems
      .filter(txnItem => txnItem.itemType.startsWith("ticket"))
      .map(async (txnItem) => {
        return await models.Ticket.findById(txnItem.itemId)
      })
    )

    var ticket = tickets.find(t => t.boardStopId === tripInstances[0].tripStops[0].id)

    await tripInstances[0].reload()
    const seatsAvailable = tripInstances[0].seatsAvailable

    // Refund a ticket...
    var refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/tickets/${ticket.id}/refund/route_pass`,
      payload: {
        targetAmt: tripPrice,
        creditTag
      },
      headers: authHeaders.admin
    })

    expect(refundResponse.statusCode).to.equal(200)

    var refundTIByType = _.groupBy(refundResponse.result.transactionItems, ti => ti.itemType)

    expect(_.keys(refundTIByType).length).equal(3)
    expect(refundTIByType.routePass).exist()
    expect(refundTIByType.routePass.length).equal(1)
    expect(refundTIByType.routePass[0].itemType).equal('routePass')
    expect(refundTIByType.routePass[0].credit).equal(tripPrice)
    expect(refundTIByType.account).exist()
    expect(refundTIByType.account.length).equal(2)
    expect(refundTIByType.ticketRefund).exist()

    await tripInstances[0].reload()
    expect(seatsAvailable + 1).equal(tripInstances[0].seatsAvailable)

    const routePassInst = await models.RoutePass.findById(refundTIByType.routePass[0].itemId)
    expect(routePassInst.notes.refundedTicketId).equal(ticket.id)

    await models.PromoUsage.destroy({ where: { promoId: promoInst.id }})
    await promoInst.destroy()
  })

  function expectTransactionItemsConsistent (response, refundAmount) {
    const refundTIByType = _.groupBy(response.result.transactionItems, ti => ti.itemType)

    expect(refundTIByType.refundPayment).exist()
    expect(refundTIByType.refundPayment.length).equal(1)
    expect(refundTIByType.refundPayment[0].creditF).about(refundAmount, 0.001)
    expect(refundTIByType.refundPayment[0].refundPayment.paymentResource).exist()
    expect(refundTIByType.refundPayment[0].refundPayment.data).exist()
    expect(refundTIByType.transfer).exist()
    expect(refundTIByType.transfer.length).equal(2)
    expect(refundTIByType.account).exist()
    expect(refundTIByType.account.length).equal(1)
    expect(refundTIByType.routePass).exist()
    expect(refundTIByType.routePass.length).equal(1)
  }

  lab.test("Refund of route pass", {timeout: 60000}, async function () {
    await models.RoutePass.destroy({ truncate: true })

    const tripPrice = _.sortBy(tripInstances, 'date')[0].priceF

    const firstPurchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 1,
        tag: creditTag,
        stripeToken: await createStripeToken(),
        companyId: companyInstance.id,
      },
      headers: authHeaders.user
    })
    expect(firstPurchaseResponse.statusCode).to.equal(200)

    const firstTransactionItem = firstPurchaseResponse.result.transactionItems.find(i => i.itemType === 'routePass')
    const routePassInst = await models.RoutePass.findById(firstTransactionItem.itemId)

    // Refund a route pass...
    const firstRefundResponse = await server.inject({
      method: "POST",
      url: `/transactions/route_passes/${routePassInst.id}/refund/payment`,
      payload: {
        transactionItemId: firstTransactionItem.id
      },
      headers: authHeaders.admin
    })
    expect(firstRefundResponse.statusCode).to.equal(200)
    const routePassTransactionItem = firstRefundResponse.result.transactionItems.find(ti => ti.itemType === 'routePass')
    expect(routePassTransactionItem.notes).equal({refundedTransactionId: firstTransactionItem.transactionId})

    await routePassInst.reload()
    expect(routePassInst.status).equal('refunded')

    expectTransactionItemsConsistent(firstRefundResponse, tripPrice)
  })

  lab.test("Refund of route pass with promo", {timeout: 60000}, async function () {
    const promoCode = randomString()

    let oldPromo = await models.Promotion.find({ where: { code: promoCode }})
    if (oldPromo) {
      await models.PromoUsage.destroy({ where: { promoId: oldPromo.id }})
      await oldPromo.destroy()
    }
    let promoInst = await models.Promotion.create({
      code: promoCode,
      type: 'RoutePass',
      params: {
        tag: creditTag,
        qualifyingCriteria: [
          {type: 'noLimit', params: {}},
        ],
        discountFunction: {
          type: "simpleRate",
          params: {"rate": 0.5}
        },
        refundFunction: {
          type: "refundDiscountedAmt"
        },
        usageLimit: {
          globalLimit: 10,
          userLimit: 10
        }
      },
      description: `Test promo ${Date.now()}`
    })

    await models.RoutePass.destroy({ truncate: true })

    const tripPrice = _.sortBy(tripInstances, 'date')[0].priceF

    const firstPurchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 1,
        tag: creditTag,
        stripeToken: await createStripeToken(),
        promoCode: { code: promoCode },
        companyId: companyInstance.id,
      },
      headers: authHeaders.user
    })
    expect(firstPurchaseResponse.statusCode).to.equal(200)

    const firstTransactionItem = firstPurchaseResponse.result.transactionItems.find(i => i.itemType === 'routePass')
    const routePassInst = await models.RoutePass.findById(firstTransactionItem.itemId)

    // Refund a route pass...
    const firstRefundResponse = await server.inject({
      method: "POST",
      url: `/transactions/route_passes/${routePassInst.id}/refund/payment`,
      payload: {
        transactionItemId: firstTransactionItem.id
      },
      headers: authHeaders.admin
    })
    expect(firstRefundResponse.statusCode).to.equal(200)
    const routePassTransactionItem = firstRefundResponse.result.transactionItems.find(ti => ti.itemType === 'routePass')
    expect(routePassTransactionItem.notes).equal({refundedTransactionId: firstTransactionItem.transactionId})

    await routePassInst.reload()
    expect(routePassInst.status).equal('refunded')

    expectTransactionItemsConsistent(firstRefundResponse, tripPrice - roundToNearestCent(0.5 * tripPrice))

    await promoInst.destroy()
  })

  lab.test("Apply route credits works and is not refundable", {timeout: 15000}, async () => {
    const rpTag = 'rp-' + routeInstance.id
    await routeInstance.update({ tags: [rpTag] })

    const purchaseResponse = await server.inject({
      method: 'POST',
      url: `/transactions/route_passes/payment`,
      payload: {
        quantity: 1,
        tag: rpTag,
        stripeToken: await createStripeToken(),
        companyId: companyInstance.id,
      },
      headers: authHeaders.user
    })
    expect(purchaseResponse.statusCode).to.equal(200)

    const transactionItem = purchaseResponse.result.transactionItems.find(i => i.itemType === 'routePass')
    const routePass = await models.RoutePass.findById(transactionItem.itemId)

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
        applyRoutePass: true,
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)
    await routePass.reload()
    expect(routePass.status).equal('void')
    expect(routePass.notes.ticketId).exist()

    const refundResponse = await server.inject({
      method: "POST",
      url: `/transactions/route_passes/${routePass.id}/refund/payment`,
      payload: {
        transactionItemId: transactionItem.id
      },
      headers: authHeaders.admin
    })
    expect(refundResponse.statusCode).to.equal(400)

    await routePass.destroy()
  })

  lab.test("Crowdstart credits favoured over rp ones", {timeout: 15000}, async () => {
    const rpTag = 'rp-' + routeInstance.id
    const cTag = 'crowdstart-1337'
    await routeInstance.update({ tags: [rpTag, cTag] })
    await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: rpTag
      },
      headers: authHeaders.admin,
    })
    const routePass = await models.RoutePass.find({
      where: {
        companyId: companyInstance.id,
        userId: userInstance.id,
        tag: rpTag,
        status: 'valid',
      }
    })
    await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInstance.id,
        routeId: routeInstance.id,
        tag: cTag
      },
      headers: authHeaders.admin,
    })
    const crowdstartPass = await models.RoutePass.find({
      where: {
        companyId: companyInstance.id,
        userId: userInstance.id,
        tag: cTag,
        status: 'valid',
      }
    })

    var saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[0].id,
          // qty: 1
        }],
        stripeToken: await createStripeToken(),
        applyRoutePass: true,
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(200)
    await routePass.reload()
    expect(routePass.status).equal('valid')
    await routePass.destroy()

    await crowdstartPass.reload()
    expect(crowdstartPass.status).equal('void')
    expect(crowdstartPass.notes.ticketId).exist()
    await routePass.destroy()
  })
})
