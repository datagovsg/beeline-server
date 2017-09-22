import Lab from "lab"
import {expect} from "code"
import BlueBird from 'bluebird'
import _ from "lodash"
import {loginAs, resetTripInstances} from "./test_common"
import {createUsersCompaniesRoutesAndTrips} from './test_data'
import {stripe} from "../src/lib/transactions/payment"

export const lab = Lab.script()

const {models: m} = require("../src/lib/core/dbschema")()
const server = require("../src/index.js")

// For monkey-patching
const email = require('../src/lib/util/email')

lab.experiment("WRS", function () {
  var testInstances = []
  var companyInstance, routeInstance, stopInstances, tripInstances

  lab.before({timeout: 15000}, async () => {
    var user
    const prices = _.range(0, 9).map(() => (Math.random() * 3 + 3).toFixed(2));
    ({userInstance: user, companyInstance, routeInstance, stopInstances, tripInstances} =
      await createUsersCompaniesRoutesAndTrips(m, prices))

    await routeInstance.update({ tags: ['wrs'] })

    testInstances.push(user)
    testInstances.push(companyInstance)
    testInstances = testInstances.concat(stopInstances)
    testInstances.push(routeInstance)
    testInstances = testInstances.concat(tripInstances)

    // Tag the trips with child ticket prices
    await Promise.all(tripInstances.map(tripInstance =>
      tripInstance.update({
        bookingInfo: {
          childTicketPrice: (Math.random() * 1 + 2).toFixed(2),
        },
      })
    ))

    // create the children promotion
    await m.Promotion.create({
      code: 'WRS-CHILDREN',
      type: 'Promotion',
      params: {
        qualifyingCriteria: [{
          type: 'limitByRouteTags',
          params: { tags: ['wrs'] },
        }, {
          type: 'limitByTripDate',
          params: {
            startDate: '2016-09-30',
            endDate: '2060-01-01'
          }
        }, {
          type: 'childTickets'
        }],
        discountFunction: {
          type: 'childRate',
        },
        refundFunction: {
          type: 'refundDiscountedAmt'
        },
        usageLimit: {
          userLimit: null,
          globalLimit: null
        }
      },
      description: 'Child ticket'
    })


    var loginResponse = await loginAs("user", user.id)
    expect(loginResponse.statusCode).to.equal(200)
  })

  lab.afterEach(async () => resetTripInstances(m, tripInstances))

  lab.after(async () => {
    for (var i = testInstances.length - 1; i >= 0; i--) {
      testInstances[i] = await testInstances[i].destroy() // eslint-disable-line no-await-in-loop
    }
  })

  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("Payment works", {timeout: 10000}, async function () {
    var emailFn = email.send
    var error

    try {
      // create a stripe token! Using the fake credit card details
      var stripeToken = await BlueBird.promisify(stripe.tokens.create, {context: stripe.tokens})({
        card: {
          number: "4242424242424242",
          exp_month: "12",
          exp_year: "2017",
          cvc: "123"
        }
      })

      // Inject the ticket purchases
      var saleResponse = await server.inject({
        method: "POST",
        url: "/custom/wrs/payment_ticket_sale",
        payload: {
          trips: [
            {
              tripId: tripInstances[1].id,
              boardStopId: tripInstances[1].tripStops[0].id,
              alightStopId: tripInstances[1].tripStops[0].id,
            },
            {
              tripId: tripInstances[2].id,
              boardStopId: tripInstances[2].tripStops[1].id,
              alightStopId: tripInstances[2].tripStops[1].id,
            }
          ],
          qty: 3,
          name: 'Mr Test',
          email: `mrtest${Date.now()}@example.com`,
          telephone: '81234567',
          stripeToken: stripeToken.id
        },
      })
      expect(saleResponse.statusCode).to.equal(200)
      /* For backward compatibility :( */
      expect(saleResponse.result.transactionid).exist()
      expect(saleResponse.result.transactionId).exist()
      expect(saleResponse.result.sessionToken).exist()

      // Get the transaction
      var transaction = await m.Transaction.findById(saleResponse.result.transactionId,
        {
          include: [m.TransactionItem]
        })

      // Find the one payment item
      var itemsByType = _.groupBy(transaction.transactionItems, ti => ti.itemType)
      expect(itemsByType.payment.length).equal(1)

      // Ensure the correct amount was charged
      var paymentItem = await m.Payment.findById(itemsByType.payment[0].itemId)
      var expectedPriceCents = Math.round(3 * (100 * tripInstances[1].price + 100 * tripInstances[2].price))
      expect(paymentItem.data.amount).equal(expectedPriceCents)
      expect(itemsByType.payment[0].debit).equal((expectedPriceCents / 100).toFixed(2))

      // There should be six tickets
      expect(itemsByType.ticketSale.length).equal(6)
      var ticketIds = itemsByType.ticketSale.map(ts => ts.itemId)
      var tickets = await m.Ticket.findAll({
        where: { id: {$in: ticketIds} }
      })

      // Trip availability should be updated accordingly
      var trips = await m.Trip.findAll({
        where: { id: {$in: [tripInstances[1].id, tripInstances[2].id]} }
      })

      var tripAvailability = trips.map(t => t.seatsAvailable)
      expect(tripAvailability).to.only.include(7)

      // When grouping the tickets by userId, each userId should have two tickets
      var ticketsByUserId = _.groupBy(tickets, t => t.userId)
      _.forEach(ticketsByUserId, (value, key) => {
        expect(value.length).equal(2)
      })

      // Ensure ticket can be emailed to ourselves.
      // Monkey-patch sendEmail
      var adminInst = await loginAs('admin', {
        transportCompanyId: companyInstance.id,
        permissions: [],
        email: 'test-null@beeline.sg'
      })
      email.send = function (what) {
        console.log("MONKEY-PATCHED send() function")
        expect((what.from || what.From).endsWith('@beeline.sg')).true()
        expect((what.to || what.To).indexOf('@')).not.equal(-1)
      }

      const transactionId = saleResponse.result.transactionId
      expect((await server.inject({
        url: `/custom/wrs/email/${transactionId}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminInst.result.sessionToken}`
        }
      })).statusCode).equal(200)

      const sessionToken = saleResponse.result.sessionToken
      const badSessionToken = sessionToken.substr(0, sessionToken.length - 3)

      var successResponse = await server.inject({
        method: "GET",
        url: `/custom/wrs/tickets/${transactionId}/${sessionToken}`,
      })
      expect(successResponse.statusCode).to.equal(200)

      var failedResponse = await server.inject({
        method: "GET",
        url: `/custom/wrs/tickets/${transactionId}/${badSessionToken}`,
      })
      expect(failedResponse.statusCode).to.equal(403)
    } catch (err) {
      console.error(err.stack)
      error = err
    } finally {
      email.send = emailFn
    }
    if (error) throw error
  })

  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("Payment + Discount works", {timeout: 10000}, async function () {
    var emailFn = email.send
    var error

    try {
      // create a stripe token! Using the fake credit card details
      var stripeToken = await stripe.tokens.create({
        card: {
          number: "4242424242424242",
          exp_month: "12",
          exp_year: "2017",
          cvc: "123"
        }
      })

      // Inject the ticket purchases
      var saleResponse = await server.inject({
        method: "POST",
        url: "/custom/wrs/payment_ticket_sale",
        payload: {
          trips: [
            {
              tripId: tripInstances[1].id,
              boardStopId: tripInstances[1].tripStops[0].id,
              alightStopId: tripInstances[1].tripStops[0].id,
            },
            {
              tripId: tripInstances[2].id,
              boardStopId: tripInstances[2].tripStops[1].id,
              alightStopId: tripInstances[2].tripStops[1].id,
            }
          ],
          qty: 5,
          qtyChildren: 2,
          name: 'Mr Test',
          email: `mrtest${Date.now()}@example.com`,
          telephone: '81234567',
          stripeToken: stripeToken.id
        },
      })
      expect(saleResponse.statusCode).to.equal(200)
      /* For backward compatibility :( */
      expect(saleResponse.result.transactionid).exist()
      expect(saleResponse.result.transactionId).exist()
      expect(saleResponse.result.sessionToken).exist()

      // Get the transaction
      var transaction = await m.Transaction.findById(saleResponse.result.transactionId,
        {
          include: [m.TransactionItem]
        })

      // Find the one payment item
      var itemsByType = _.groupBy(transaction.transactionItems, ti => ti.itemType)
      expect(itemsByType.payment.length).equal(1)

      // Ensure the correct amount was charged
      var paymentItem = await m.Payment.findById(itemsByType.payment[0].itemId)
      var expectedPriceCents = Math.round(
        3 * (100 * tripInstances[1].price + 100 * tripInstances[2].price) +
        2 * (100 * tripInstances[1].bookingInfo.childTicketPrice + 100 * tripInstances[2].bookingInfo.childTicketPrice)
      )
      expect(paymentItem.data.amount).equal(expectedPriceCents)
      expect(itemsByType.payment[0].debit).equal((expectedPriceCents / 100).toFixed(2))

      // There should be eight tickets
      expect(itemsByType.ticketSale.length).equal(10)
      const ticketIds = itemsByType.ticketSale.map(ts => ts.itemId)
      const tickets = await m.Ticket.findAll({
        where: { id: {$in: ticketIds} }
      })

      // Check that notes.discountCodes is set
      const ticketsWithDiscount = tickets.filter(ti =>
        _.get(ti, 'notes.discountCodes'))
      expect(ticketsWithDiscount.length).equal(4)
      for (let ti of ticketsWithDiscount) {
        expect(_.get(ti, 'notes.discountCodes[0]')).equal('WRS-CHILDREN')
      }

      // When grouping the tickets by userId, each userId should have two tickets
      var ticketsByUserId = _.groupBy(tickets, t => t.userId)
      _.forEach(ticketsByUserId, (value, key) => {
        expect(value.length).equal(2)
      })
    } catch (err) {
      error = err
    } finally {
      email.send = emailFn
    }
    if (error) throw error
  })


  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("When payment fails it fails cleanly", {timeout: 10000}, async function () {
    // create 11 fake users
    var email = `mrtest${Date.now()}@example.com`

    // Inject the ticket purchases
    var saleResponse = await server.inject({
      method: "POST",
      url: "/custom/wrs/payment_ticket_sale",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[1].id,
            alightStopId: tripInstances[2].tripStops[1].id,
          }
        ],
        qty: 3,
        name: 'Mr Test',
        email,
        telephone: '81234567',
        stripeToken: 'Fake stripe token!'
      },
    })
    expect(saleResponse.statusCode).equal(402)
    // User-readable message
    expect(typeof saleResponse.result.message).equal('string')

    // Get the tickets -- ensure they are all failed
    var tickets = await m.Ticket.findAll(
      {
        include: [
          {
            model: m.User,
            where: {name: {$ilike: `%${email}%`}}
          }
        ]
      })
    expect(tickets.length).above(0)
    expect(_.every(tickets, t => t.status === 'failed'))

    // Get their associated transaction -- ensure it is not committed
    var transactions = await m.Transaction.findAll({
      include: [
        {
          model: m.TransactionItem,
          where: {itemType: 'ticketSale', itemId: {$in: tickets.map(t => t.id)}}
        }
      ]
    })
    expect(transactions.length).equal(1)
    expect(transactions[0].committed).equal(false)
  })

  // Stripe takes a while to respond, so we set a longer timeout
  lab.test("Useful error messages", {timeout: 10000}, async function () {
    var stripeToken = await stripe.tokens.create({
      card: {
        number: "4000000000000341",
        exp_month: "12",
        exp_year: "2020",
        cvc: "123"
      }
    })
    var email = `mrtest${Date.now()}@example.com`

    // Inject the ticket purchases
    var saleResponse = await server.inject({
      method: "POST",
      url: "/custom/wrs/payment_ticket_sale",
      payload: {
        trips: [
          {
            tripId: tripInstances[1].id,
            boardStopId: tripInstances[1].tripStops[0].id,
            alightStopId: tripInstances[1].tripStops[0].id,
          },
          {
            tripId: tripInstances[2].id,
            boardStopId: tripInstances[2].tripStops[1].id,
            alightStopId: tripInstances[2].tripStops[1].id,
          }
        ],
        qty: 3,
        name: 'Mr Test',
        email,
        telephone: '81234567',
        stripeToken: stripeToken.id
      },
    })
    expect(saleResponse.statusCode).equal(402)
    // User-readable message
    expect(typeof saleResponse.result.message).equal('string')
    expect(saleResponse.result.message.toUpperCase()).contains('CARD')
    expect(saleResponse.result.message.toUpperCase()).contains('DECLINED')
  })
})
