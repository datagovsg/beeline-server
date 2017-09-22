const {db, models: m} = require('../src/lib/core/dbschema')()
const {
  resetTripInstances, loginAs,
  randomEmail, randomString, createStripeToken
} = require("./test_common")
import {expect, fail} from "code"
import server from "../src/index"
import Lab from "lab"
import _ from 'lodash'
import {createUsersCompaniesRoutesAndTrips, createTripInstancesFrom} from './test_data'
import {initBuilderWithTicketSale, TransactionBuilder} from '../src/lib/transactions/builder'
import * as Credits from '../src/lib/promotions/Credits'

export var lab = Lab.script()

lab.experiment("Credits", function () {
  var userInstance, companyInstance, routeInstance, stopInstances, tripInstances
  var templates
  var authHeaders = {}

  lab.before({timeout: 15000}, async function () {
    ({userInstance, companyInstance, routeInstance, tripInstances, stopInstances} =
        await createUsersCompaniesRoutesAndTrips(m))

    var userToken = (await loginAs("user", userInstance.id)).result.sessionToken
    authHeaders.user = {authorization: "Bearer " + userToken}

    var adminToken = (await loginAs("admin", {
      transportCompanyId: companyInstance.id,
      permissions: ['refund']
    })).result.sessionToken
    authHeaders.admin = {authorization: "Bearer " + adminToken}

    templates = {
      connection: {db, models: m, dryRun: false, committed: true},
      items: [
        {
          item: {
            tripId: tripInstances[0].id,
            boardStopId: tripInstances[0].tripStops[0].id,
            alightStopId: tripInstances[0].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 0},
          price: tripInstances[0].price,
          trip: tripInstances[0]
        },
        {
          item: {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 1},
          price: tripInstances[1].price,
          trip: tripInstances[1]
        },
        {
          item: {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[0].id,
            alightStopId: tripInstances[2].tripStops[2].id,
            userId: userInstance.id
          },
          ticket: {id: 2},
          price: tripInstances[2].price,
          trip: tripInstances[2]
        }
      ],
      promoParams: {
        qualifyingCriteria: [
            {type: 'limitByCompany', params: {companyId: companyInstance.id}},
            {type: 'limitByRoute', params: {routeIds: [routeInstance.id]}},
        ],
      }
    }
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get "user already has ticket" errors, or unexpected
    capacity errors
  */
  lab.afterEach(async () => resetTripInstances(m, tripInstances))

  lab.test('Adding/subtracting of credits', {timeout: 20000}, async function () {
    var userInst = await m.User.create({telephone: randomEmail()})

    // Test within a transaction
    await db.transaction({
      isolationLevel: 'SERIALIZABLE',
    }, async (t) => {
      var initialCredit = await m.Credit.getUserCredits(userInst.id, {transaction: t})

      expect(initialCredit).equal('0.00')

      await m.Credit.addUserCredits(
        userInst.id, '3.00', {transaction: t}
      )

      expect(await m.Credit.getUserCredits(userInst.id, {transaction: t}))
        .equal('3.00')

      await m.Credit.addUserCredits(userInst.id, '1.50', {transaction: t})

      expect(await m.Credit.getUserCredits(userInst.id, {transaction: t}))
        .equal('4.50')

      await m.Credit.subtractUserCredits(userInst.id, '2.00', {transaction: t})

      expect(await m.Credit.getUserCredits(userInst.id, {transaction: t}))
        .equal('2.50')

      try {
        await m.Credit.subtractUserCredits(userInst.id, '2.51', {transaction: t})
        fail("Should not be reached")
      } catch (err) {
        expect(err).exist()
      }

      try {
        await m.Credit.addUserCredits(userInst.id, '-2.51', {transaction: t})
        fail("Should not be reached")
      } catch (err) {
        expect(err).exist()
      }

      expect(await m.Credit.getUserCredits(userInst.id, {transaction: t}))
        .equal('2.50')

        // Don't commit -- check that the transaction is actually rolled back.
      throw new Error("BlahBlah")
    })
      .catch((err) => {
        if (err.message !== 'BlahBlah') {
          throw err
        }
      })

      // Transaction has been rolled back, credits = 0
    expect(await m.Credit.getUserCredits(userInst.id))
      .equal('0.00')
  })

  lab.test('Credits work as part of a purchase order', async function () {
    var userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: '5.00'
    })

    const poItems = templates.items.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await Credits.applyCredits(transactionBuilder)

    // Check the state before finalization...
    const items = withCredits.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding).below(item.price * 1.0)
        .above(0)
    }

    const totalDiscount =
        _.sumBy(items, i => parseFloat(i.price)) -
        _.sumBy(items, i => parseFloat(i.transactionItem.notes.outstanding))
    const creditsCredit = withCredits.transactionItemsByType.userCredit[0].debit

    expect(totalDiscount).about(5, 0.002)
    expect(creditsCredit).about(5, 0.002)

    const finalized = await withCredits.finalizeForPayment(companyInstance.id)
    await finalized.build()

    expect(await m.Credit.getUserCredits(userId))
      .equal('0.00')
  })

  // FIXME: test the transactionBuilder
  lab.test('Credits work as part of a purchase order (2) -- full subsidy', async function () {
    var userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: '1000.00'
    })

    const poItems = templates.items.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await Credits.applyCredits(transactionBuilder)

    // Check the state before finalization...
    const items = withCredits.items
    for (let item of items) {
      expect(item.transactionItem.notes.outstanding).equal(0)
    }

    const totalPrice = _.sumBy(items, i => parseFloat(i.price))
    const creditsCredit = withCredits.transactionItemsByType.userCredit[0].debit

    expect(totalPrice).about(creditsCredit, 0.002)

    const finalized = await withCredits.finalizeForPayment(companyInstance.id)
    await finalized.build()

    expect(parseFloat(await m.Credit.getUserCredits(userId))).about(1000 - totalPrice, 0.002)
  })

  // SETUP:
  // Credit Balance: '12.60'
  // Buying 3 x '4.2' Tickets
  // Expect total discounted (~12.6000001) > balance (12.60)
  // Expect final balance in credits = 0 after deduction
  lab.test('Credits is able to deal with floating point discrepancies (totalDiscounted > creditBalance)', async function () {
    var userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {
        userId,
      }
    })
    await m.Credit.create({
      userId,
      balance: '12.60'
    })

    const trips = await createTripInstancesFrom(
      m,
      {routeInstance, companyInstance, stopInstances},
      [4.2, 4.2, 4.2]
    )

    const itemInsts = [
      {
        item: {
          tripId: trips[0].id,
          boardStopId: trips[0].tripStops[0].id,
          alightStopId: trips[0].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 0},
        price: trips[0].price,
        trip: trips[0]
      },
      {
        item: {
          tripId: trips[1].id,
          boardStopId: trips[1].tripStops[0].id,
          alightStopId: trips[1].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 1},
        price: trips[1].price,
        trip: trips[1]
      },
      {
        item: {
          tripId: trips[2].id,
          boardStopId: trips[2].tripStops[0].id,
          alightStopId: trips[2].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 2},
        price: trips[2].price,
        trip: trips[2]
      },
    ]

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await Credits.applyCredits(transactionBuilder)

    const finalized = await withCredits.finalizeForPayment(companyInstance.id)
    await finalized.build()

    expect(parseFloat(await m.Credit.getUserCredits(userId)))
      .equal(0)
  })

  // SETUP:
  // Credit Balance: '14.40'
  // Buying 3 x '4.8' Tickets
  // Expect total discounted (~14.3999999) < balance (14.40)
  // Expect final balance in credits = 0 after deduction
  lab.test('Credits is able to deal with floating point discrepancies (totalDiscounted < creditBalance)', async function () {
    var userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {
        userId,
      }
    })
    await m.Credit.create({
      userId,
      balance: '14.40'
    })

    const trips = await await createTripInstancesFrom(
      m,
      {routeInstance, companyInstance, stopInstances},
      [4.8, 4.8, 4.8]
    )

    const itemInsts = [
      {
        item: {
          tripId: trips[0].id,
          boardStopId: trips[0].tripStops[0].id,
          alightStopId: trips[0].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 0},
        price: trips[0].price,
        trip: trips[0]
      },
      {
        item: {
          tripId: trips[1].id,
          boardStopId: trips[1].tripStops[0].id,
          alightStopId: trips[1].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 1},
        price: trips[1].price,
        trip: trips[1]
      },
      {
        item: {
          tripId: trips[2].id,
          boardStopId: trips[2].tripStops[0].id,
          alightStopId: trips[2].tripStops[2].id,
          userId: userInstance.id
        },
        ticket: {id: 2},
        price: trips[2].price,
        trip: trips[2]
      },
    ]

    const poItems = itemInsts.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await Credits.applyCredits(transactionBuilder)
    const finalized = await withCredits.finalizeForPayment(companyInstance.id)
    await finalized.build()

    expect(parseFloat(await m.Credit.getUserCredits(userId)))
      .equal(0)
  })

  lab.test("Credits are deducted after a purchase", {timeout: 10000}, async () => {
    const userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: '5.00'
    })

    const purchaseItems = [{
      tripId: tripInstances[0].id,
      boardStopId: tripInstances[0].tripStops[0].id,
      alightStopId: tripInstances[0].tripStops[4].id,
    }, {
      tripId: tripInstances[1].id,
      boardStopId: tripInstances[1].tripStops[0].id,
      alightStopId: tripInstances[1].tripStops[4].id,
    }, {
      tripId: tripInstances[2].id,
      boardStopId: tripInstances[2].tripStops[0].id,
      alightStopId: tripInstances[2].tripStops[4].id,
    }, {
      tripId: tripInstances[3].id,
      boardStopId: tripInstances[3].tripStops[0].id,
      alightStopId: tripInstances[3].tripStops[4].id,
    }, {
      tripId: tripInstances[4].id,
      boardStopId: tripInstances[4].tripStops[0].id,
      alightStopId: tripInstances[4].tripStops[4].id,
    }]

    const previewResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/quote",
      payload: {
        trips: purchaseItems,
        stripeToken: await createStripeToken(),
        applyCredits: true,
      },
      headers: authHeaders.user
    })

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: purchaseItems,
        stripeToken: await createStripeToken(),
        applyCredits: true,
      },
      headers: authHeaders.user,
    })
    expect(saleResponse.statusCode).to.equal(200)

    expect(parseFloat(previewResponse.result.transactionItems
      .find(it => it.itemType === 'userCredit').debit).toFixed(2)).equal('5.00')
    expect(saleResponse.result.transactionItems.find(it => it.itemType === 'userCredit').debit).equal('5.00')

    const previewPaymentAmount = previewResponse.result.transactionItems.find(it => it.itemType === 'payment').debit
    const salePaymentAmount = saleResponse.result.transactionItems.find(it => it.itemType === 'payment').debit
    expect(parseFloat(previewPaymentAmount)).equal(parseFloat(salePaymentAmount))

    const amountPaid = parseFloat(previewPaymentAmount)
    const sumPayments = _.sum(_.values(saleResponse.result.transactionItems.find(it => it.itemType === 'payment').notes.tickets))
    const sumCredits = _.sum(_.values(saleResponse.result.transactionItems.find(it => it.itemType === 'userCredit').notes.tickets))

    expect(amountPaid).about(sumPayments, 0.0001)
    expect(sumCredits).about(5, 0.0001)

    expect(await m.Credit.getUserCredits(userId)).equal('0.00')
  })

  lab.test("Credits don't change after a failed purchase", {timeout: 10000}, async () => {
    const userId = userInstance.id

    // Create the user credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: '5.00'
    })

    const saleResponse = await server.inject({
      method: "POST",
      url: "/transactions/tickets/payment",
      payload: {
        trips: [{
          tripId: tripInstances[0].id,
          boardStopId: tripInstances[0].tripStops[0].id,
          alightStopId: tripInstances[0].tripStops[4].id,
        }, {
          tripId: tripInstances[1].id,
          boardStopId: tripInstances[1].tripStops[0].id,
          alightStopId: tripInstances[1].tripStops[4].id,
        }, {
          tripId: tripInstances[2].id,
          boardStopId: tripInstances[2].tripStops[0].id,
          alightStopId: tripInstances[2].tripStops[4].id,
        }, {
          tripId: tripInstances[3].id,
          boardStopId: tripInstances[3].tripStops[0].id,
          alightStopId: tripInstances[3].tripStops[4].id,
        }, {
          tripId: tripInstances[4].id,
          boardStopId: tripInstances[4].tripStops[0].id,
          alightStopId: tripInstances[4].tripStops[4].id,
        }],
        stripeToken: 'Fake stripe token',
        applyCredits: true,
      },
      headers: authHeaders.user
    })
    expect(saleResponse.statusCode).to.equal(402)

    expect(await m.Credit.getUserCredits(userId)).equal('5.00')
  })

  lab.test("Test moveCredits - adding and removing of credits", {timeout: 10000}, async () => {
    expect(userInstance).exist()

    // Ensure accounts exist
    var [accountInst] = await m.Account.findOrCreate({
      where: {name: 'Credits Expense'},
      defaults: {name: 'Credits Expense'}
    })

    expect(accountInst).exist()

    const initialCredit = parseFloat(await m.Credit.getUserCredits(userInstance.id))
    var creditInst = await m.Credit.findById(userInstance.id)

    expect(creditInst).exist()

    // define variables
    const amtExchanged = 29.99
    var expensesAccount = {itemType: 'account', itemId: accountInst.id}
    var userCreditAccount = {itemType: 'userCredit', itemId: userInstance.id}
    let description = "Test moveCredits - add"

    let tb, txnInst

    await db.transaction(async (transaction) => {
      tb = new TransactionBuilder({
        db, transaction,
        models: m,
        dryRun: false,
        committed: true,
        creator: {
          type: 'system',
        },

      })

      tb.description = description

      // add credits to user account
      tb = await m.Credit.moveCredits(expensesAccount, userCreditAccount, amtExchanged, tb)

      let [txnInstance] = await tb.build({type: 'referralRewards'})
      txnInst = txnInstance
    })

    await creditInst.reload()

    expect(creditInst.balance).equal((initialCredit + amtExchanged).toFixed(2))

    // check if transaction entry, and transactionItem entries, are created correctly
    var transactionInst = await m.Transaction.find({
      where: {
        id: txnInst.id
      },
      include: [m.TransactionItem]
    })

    expect(transactionInst).exist()

    var transactionItems = transactionInst.transactionItems

    expect(transactionItems.length).equal(2)

    var deductionInst = transactionItems.find(it => it.itemType === 'account')

    expect(deductionInst).exist()
    expect(deductionInst.itemId).equal(accountInst.id)
    expect(deductionInst.debit).equal((amtExchanged).toString())

    var additionInst = transactionItems.find(it => it.itemType === 'userCredit')

    expect(additionInst).exist()
    expect(additionInst.itemId).equal(userInstance.id)
    expect(additionInst.debit).equal((-amtExchanged).toString())

    // reset necessary variables
    expensesAccount = {itemType: 'account', itemId: accountInst.id}
    userCreditAccount = {itemType: 'userCredit', itemId: userInstance.id}
    description = "Test moveCredits - subtract"

    await db.transaction(async (transaction) => {
      tb = new TransactionBuilder({
        db, transaction,
        models: m,
        dryRun: false,
        committed: true,
        creator: {
          type: 'system',
        },
      })

      tb.description = description

      // subtract credits from user account
      tb = await m.Credit.moveCredits(userCreditAccount, expensesAccount, amtExchanged, tb)

      let [txnInstance] = await tb.build({ type: 'referralRewards'})
      txnInst = txnInstance
    })

    await creditInst.reload()

    expect(creditInst.balance).equal((initialCredit).toFixed(2))

    // check if transaction entry, and transactionItem entries, are created correctly
    transactionInst = await m.Transaction.find({
      where: {
        id: txnInst.id
      },
      include: [m.TransactionItem]
    })

    expect(transactionInst).exist()

    transactionItems = transactionInst.transactionItems

    expect(transactionItems.length).equal(2)

    deductionInst = transactionItems.find(it => it.itemType === 'userCredit')

    expect(deductionInst).exist()
    expect(deductionInst.itemId).equal(userInstance.id)
    expect(deductionInst.debit).equal((amtExchanged).toString())

    additionInst = transactionItems.find(it => it.itemType === 'account')

    expect(additionInst).exist()
    expect(additionInst.itemId).equal(accountInst.id)
    expect(additionInst.debit).equal((-amtExchanged).toString())
  })

  lab.test("Test moveCredits - within transaction", {timeout: 10000}, async () => {
    expect(userInstance).exist()

    // Ensure accounts exist
    var [accountInst] = await m.Account.findOrCreate({
      where: {name: 'Credits distributed'},
      defaults: {name: 'Credits distributed'}
    })

    expect(accountInst).exist()

    var initialCredit = parseFloat(await m.Credit.getUserCredits(userInstance.id))
    var creditInst = await m.Credit.findById(userInstance.id)

    expect(creditInst).exist()

    // define variables
    const amtExchanged = 29.99
    var expensesAccount = {itemType: 'account', itemId: accountInst.id}
    var userCreditAccount = {itemType: 'userCredit', itemId: userInstance.id}
    const description = "Test moveCredits - in txn"

    var transactionItemCount = (await m.TransactionItem.findAll({
      attributes: [[db.fn('COUNT', db.col('id')), 'total']]
    }))[0].get('total')

    await db.transaction({
      isolationLevel: 'SERIALIZABLE',
    }, async (t) => {
      let tb = new TransactionBuilder({
        db,
        transaction: t,
        models: m,
        dryRun: false,
        committed: true,
        creator: {
          type: 'system',
        },

      })

      tb.description = description

      // add credits to user account
      tb = await m.Credit.moveCredits(expensesAccount, userCreditAccount, amtExchanged, tb)

      let [txnInstance] = await tb.build({type: 'referralRewards'})

      await creditInst.reload({transaction: t})

      expect(creditInst.balance).equal((initialCredit + amtExchanged).toFixed(2))

      // check if transaction and transactionItem entries are created correctly
      var transactionInst = await m.Transaction.find({
        where: {
          id: txnInstance.id
        },
        include: [m.TransactionItem],
        transaction: t
      })

      expect(transactionInst).exist()

      var transactionItems = transactionInst.transactionItems

      expect(transactionItems.length).equal(2)

      var deductionInst = transactionItems.find(it => it.itemType === 'account')

      expect(deductionInst).exist()
      expect(deductionInst.itemId).equal(accountInst.id)
      expect(deductionInst.debit).equal((amtExchanged).toString())

      var additionInst = transactionItems.find(it => it.itemType === 'userCredit')

      expect(additionInst).exist()
      expect(additionInst.itemId).equal(userInstance.id)
      expect(additionInst.debit).equal((-amtExchanged).toString())

      // Don't commit -- check that the transaction is actually rolled back.
      throw new Error("Expected Error")
    }).catch((err) => {
      if (err.message !== 'Expected Error') { throw err }
    })

    // Transaction has been rolled back, credits = 0
    expect(await m.Credit.getUserCredits(userInstance.id)).equal(initialCredit.toFixed(2))

    expect((await m.TransactionItem.findAll({
      attributes: [[db.fn('COUNT', db.col('id')), 'total']]
    }))[0].get('total')).equal(transactionItemCount)
  })


  lab.test("Test endpoint for GET general credits", {timeout: 10000}, async () => {
    const userId = userInstance.id
    var userInst = await m.User.create({telephone: randomEmail()})
    // Create the route credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: '5.00'
    })
    // Clear credits for 2nd user instance
    await m.Credit.destroy({
      where: {userId: userInst.id}
    })

    const noAuthResponse = await server.inject({
      method: "GET",
      url: "/credits"
    })

    const wrongAuthResponse = await server.inject({
      method: "GET",
      url: "/credits",
      headers: {authorization: _.get(authHeaders, 'user.authorization') + "xy21"}
    })

    const successNoCreditsResponse = await server.inject({
      method: "GET",
      url: "/credits",
      headers: {
        authorization: `Bearer ${userInst.makeToken()}`
      }
    })

    const successResponse = await server.inject({
      method: "GET",
      url: "/credits",
      headers: authHeaders.user
    })

    expect(noAuthResponse.statusCode).to.equal(403)
    expect(wrongAuthResponse.statusCode).to.equal(403)

    expect(successNoCreditsResponse.statusCode).to.equal(200)
    expect(successResponse.statusCode).to.equal(200)

    expect(successNoCreditsResponse.result).to.equal("0.00")
    expect(successResponse.result).to.equal("5.00")
  })

  lab.test('Credits - Correct TransactionItems are created on Purchase and Refund', async function () {
    var userId = userInstance.id
    const creditAmt = '5.00'

    // Create the user credits
    await m.Credit.destroy({
      where: {userId}
    })
    // $5 credit...
    await m.Credit.create({
      userId,
      balance: creditAmt
    })

    const poItems = templates.items.map(it => it.item)
    const transactionBuilder = await initBuilderWithTicketSale({
      db, models: m, transaction: null, dryRun: false, committed: true,
    }, poItems)

    const withCredits = await Credits.applyCredits(transactionBuilder)
    const finalized = await withCredits.finalizeForPayment(companyInstance.id)
    const [txnInstance] = await finalized.build()

    var transactionInst = await m.Transaction.find({
      where: {
        id: txnInstance.id
      },
      include: [m.TransactionItem],
      transaction: transactionBuilder.transaction
    })

    expect(transactionInst).exist()

    var transactionItems = transactionInst.transactionItems

    expect(transactionItems.length).equal(8)

    var accountInst = await m.Account.find({
      where: {
        name: 'Cost of Goods Sold'
      }
    })

    var transactionItemsByType = _.groupBy(transactionItems, ti => ti.itemType)

    const totalCOGS = _.sum(withCredits.transactionItemsByType.ticketSale.map(i => parseFloat(i.credit)))

    expect(transactionItemsByType.account).exist()
    expect(transactionItemsByType.account.length).equal(1)
    expect(transactionItemsByType.account[0].itemId).equal(accountInst.id)
    expect(transactionItemsByType.account[0].debit).equal((totalCOGS).toString())

    expect(transactionItemsByType.userCredit).exist()
    expect(transactionItemsByType.userCredit.length).equal(1)
    expect(transactionItemsByType.userCredit[0].itemId).equal(userInstance.id)
    expect(transactionItemsByType.userCredit[0].debit).equal(creditAmt)

    expect(transactionItemsByType.payables).exist()
    expect(transactionItemsByType.payables.length).equal(1)
    expect(transactionItemsByType.payables[0].itemId).equal(companyInstance.id)
    expect(transactionItemsByType.payables[0].debit).equal('-' + creditAmt)

    var amtDue = totalCOGS - parseFloat(creditAmt)

    expect(transactionItemsByType.payment).exist()
    expect(transactionItemsByType.payment.length).equal(1)
    expect(parseFloat(transactionItemsByType.payment[0].debit)).about(amtDue, 0.0001)

    expect(transactionItemsByType.transfer).exist()
    expect(transactionItemsByType.transfer.length).equal(1)
    expect(parseFloat(transactionItemsByType.transfer[0].debit)).about(-amtDue, 0.0001)
  })
})
