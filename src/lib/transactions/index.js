import Joi from "joi"
import assert from "assert"
import _ from "lodash"
import * as Payment from "../transactions/payment"
import * as auth from '../core/auth'
import Sequelize from "sequelize"
import {ChargeError, TransactionError} from '../util/errors'
import {roundToNearestCent} from '../util/common'
import {applyPromoCode} from '../promotions'
import * as Credits from '../promotions/Credits'
import * as ReferralCredits from '../promotions/ReferralProgram'

import {routePassTagsFrom, applyRoutePass} from './routePass'
import {
  TransactionBuilder, outstandingAmounts, updateTicketsWithDiscounts,
  updateTransactionBuilderWithPromoDiscounts, initBuilderWithTicketSale
} from './builder'

export {TransactionError, ChargeError}

var stripeIsLive = process.env.STRIPE_MODE === "live"

/**
Check that the sum of all transaction items in a transaction is
zero.

@db -- the Sequelize object
@t -- the transaction
@txn -- the transaction
**/

export function validateTxn (txn) {
  const items = txn.transactionItems
  assert(items)
  assert(_.every(items, 'itemId'))

  // ensure that the sum of the debit column is zero
  const sumOfDebit = _.sumBy(items, ({debit, credit}) => {
    return debit ? parseFloat(debit) : credit ? -parseFloat(credit) : 0
  })
  if (Math.abs(sumOfDebit) > 0.000001) {
    throw new Error("Transaction does not add up to zero. This is usually a programming mistake")
  }
  return txn
}

/**
 *  Prepares a ticket for sale.
 *
 *  Throws a Boom reply on failure; returns a transaction
 *  on success
 *
 *  @param options
 *    @prop trips
 *    @prop dryRun
 *
 *  FIXME: This method is terrible at concurrency. Trips cannot
 *   be booked concurrently.
 */


/* Prepare the transaction. Transaction has the following lines:
             DEBIT     CREDIT
 Ticket 1 (as Revenue account):           5.00
 Ticket 2 (as Revenue account):          10.00     [ for each ticket
 Stripe Balance (payment rcvd):    15.00
 Stripe Balance (xfer to operator):        15.00     [ for each company
 COGS (dummy expenses account):    15.00


 When we decide to implement discounts (e.g. 20% discount offered by OPERATOR)...

             DEBIT     CREDIT
 Ticket 1 (as Revenue account):           5.00
 Ticket 2 (as Revenue account):          10.00
 Discount 20%:            1.50
 PayPal Balance (payment rcvd):    13.50
 PayPal Balance (xfer to operator):        13.50     [ discounted cost of tickets
 COGS (dummy expenses account):    13.50

 When we decide to implement vouchers (e.g. we have issued credits, and user uses some credits)...

             DEBIT     CREDIT
 Ticket 1 (as Revenue account):           5.00
 Ticket 2 (as Revenue account):          10.00
 User's Credit Balance:         4.00
 PayPal Balance (payment rcvd):    11.00
 PayPal Balance (xfer to operator):        15.00     [ full cost of tickets
 COGS (dummy expenses account):    15.00

 */
export async function prepareTicketSale (connection, optionsRaw) {
  var [db, m] = connection

  // Validate input
  var {error, value: options} = Joi.object({
    trips: Joi.array().items(Joi.object({
      tripId: Joi.number().integer(),
      boardStopId: Joi.number().integer(),
      alightStopId: Joi.number().integer(),
      userId: Joi.number().integer().required(),
      // qty: Joi.number().integer().default(1).min(1),
    }).unknown()).required().min(1),

    promoCode: Joi.object({
      code: Joi.string().allow(''),
      options: Joi.object(),
    }).allow(null).default(null),

    creditTag: Joi.string().allow(null).optional(),

    dryRun: Joi.boolean().default(false),
    applyRoutePass: Joi.boolean().default(false),
    applyReferralCredits: Joi.boolean().default(false),
    applyCredits: Joi.boolean().default(false),

    checks: Joi.object({
      ensureAvailability: Joi.boolean().default(true),
      noDuplicates: Joi.boolean().default(true),
      bookingWindow: Joi.boolean().default(true)
    }).unknown()
      .default({
        ensureAvailability: true,
        noDuplicates: true,
        bookingWindow: true
      }),

    expectedPrice: Joi.number().allow(null).default(null),

    creator: Joi.object({
      type: Joi.string(),
      id: Joi.number().integer(),
    }).allow(null).optional(),

    committed: Joi.boolean().default(false),
    convertToJson: Joi.boolean().default(true),

    type: Joi.string().allow(null).optional()
  }).validate(optionsRaw) // ensure that the checks field is populated

  assert(!error, `Invalid input in prepareTicketSale() ${error && error.details}`)

  try {
    // 10 steps
    //
    // 1. Prepare convenience variables
    // 2. Check the input
    return await db.transaction({
      isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ
    }, async (t) => {
      // 1. Prepare convenience variables
      var transactionBuilder = await initBuilderWithTicketSale({
        transaction: t,
        models: m,
        db: db,
        dryRun: options.dryRun,
        committed: options.committed,
        creator: options.creator,
      }, options.trips)

      transactionBuilder.postTransactionHooks.push(transactionBuilder._saveChangesToTickets)

      // 2. Sanity checks on input
      runOrderChecks(transactionBuilder, options.checks)

      if (options.applyRoutePass || options.creditTag) {
        const routePassTags = options.creditTag
          ? [options.creditTag]
          : options.applyRoutePass
            ? (await routePassTagsFrom(
              transactionBuilder.items, transactionBuilder.models, transactionBuilder.transaction
            ))
            : []
        // If both crowdstart over rp tags are present on a route,
        // crowdstart will discount first through alphabetical order
        for (const tag of routePassTags) {
          transactionBuilder = await applyRoutePass(transactionBuilder, tag) // eslint-disable-line no-await-in-loop
        }
      }

      const promoCode = options.promoCode
      if (promoCode !== null) {
        transactionBuilder = await applyPromoCode(
          transactionBuilder,
          promoCode,
          'Promotion'
        )

        // update the tickets with the discounts...
        if (transactionBuilder.transactionItemsByType.discount) {
          updateTransactionBuilderWithPromoDiscounts(transactionBuilder, promoCode)
        }
      }

      if (options.applyReferralCredits) {
        transactionBuilder = await ReferralCredits.applyCredits(
          transactionBuilder
        )
      }

      if (options.applyCredits) {
        transactionBuilder = await Credits.applyCredits(
          transactionBuilder
        )
      }

      // 7. payment of balance
      transactionBuilder = absorbSmallPayments(transactionBuilder)

      // 8. Record the transfer sum of money to company
      // There should only be one company involved, so get the companyId
      // from any trip

      const companyId = _.values(transactionBuilder.tripsById)[0].route.transportCompanyId
      transactionBuilder = await transactionBuilder.finalizeForPayment(companyId)

      // 9. If the user did expect a particular price, ensure that the
      // prices do not differ from each other
      checkExpectedPrice(transactionBuilder, options.expectedPrice)

      return transactionBuilder.build(_.pick(options, ['type']))
    }) /* db.transaction((t) => {...}) */
  } catch (err) {
    throw err
  }
}

export async function purchaseRoutePass (options) {
  const {db, models: m, userId, dryRun, tag, promoCode, companyId, transactionType} = options

  assert(db && m && (userId || dryRun) && tag)

  return await db.transaction({
    isolationLevel: 'SERIALIZABLE',
  }, async (transaction) => {
    let connection = {
      db, models: m, transaction,
      committed: true, dryRun: dryRun || false,
      creator: {type: 'user', id: userId}
    }
    let tb = new TransactionBuilder(connection)
    tb.postTransactionHooks.push(tb._saveChangesToRoutePasses)

    // On the debit side
    tb.lineItems = null
    tb.description = `Purchase of route pass (${tag})`

    // Find the route and its indicative trip and get the trip price
    // Use this to infer the number of route passes to buy, or the
    // value of the purchase made, whichever is missing
    const route = await m.Route.find({
      attributes: ['tags'],
      where: { tags: { $contains: [tag] } },
      include: [m.IndicativeTrip],
      transaction,
    })
    assert(route, 'Unable to find the route identified by ' + tag)
    const tags = route.tags

    const price = +route.indicativeTrip.nextPrice
    assert(price, 'Unable to find price of indicative trip for route')
    assert((options.quantity && !options.value) || (!options.quantity && options.value), 'Only quantity or value should be specified, not both')
    const quantity = Math.round(options.quantity || options.value / price)
    const value = roundToNearestCent(options.value || price * quantity)

    tb.transactionItemsByType = { routePass: [] }
    if (!options.dryRun) {
      // Favour using a for loop over Promise.all
      // to help with readability
      tb.items = []
      for (var i = 0; i < quantity; ++i) {
        const routePassInst = await m.RoutePass.create( // eslint-disable-line no-await-in-loop
          {userId, companyId, tag, status: 'valid', notes: { price }},
          {transaction}
        )

        tb.undoFunctions.push(async (transaction) => {
          await routePassInst.update({ status: 'failed' }, { transaction })
        })

        const transactionItem = {
          itemType: 'routePass',
          itemId: routePassInst.id,
          credit: price,
          notes: {
            routePass: routePassInst.toJSON(),
            outstanding: parseFloat(price),
          }
        }
        tb.transactionItemsByType.routePass.push(transactionItem)

        tb.items.push(
          {
            companyId, userId, tags, price,
            type: 'routePass',
            routePass: routePassInst,
            id: routePassInst.id,
            transactionItem,
          }
        )
      }
    } else {
      tb.transactionItemsByType.routePass = _.range(0, quantity).map(
        id => ({
          itemType: 'routePass', routePass: { id, notes: {} },
          credit: price, notes: { outstanding: parseFloat(price) }
        })
      )

      // Simulate a route pass instance
      tb.items = tb.transactionItemsByType.routePass.map(
        transactionItem => ({
          id: transactionItem.routePass.id,
          type: 'routePass', routePass: transactionItem.routePass,
          companyId, tags, userId, price,
          transactionItem
        })
      )
    }

    // Apply promo code for bulk discounts
    if (promoCode) {
      tb = await applyPromoCode(
        tb,
        {
          ...promoCode,
          options: {
            ...promoCode.options,
            value
          }
        },
        'RoutePass'
      )
    }

    // update the route passes with the discounts...
    if (tb.transactionItemsByType.discount) {
      updateTransactionBuilderWithPromoDiscounts(tb, promoCode, 'routePass')
    }

    // Balance the remaining with payment
    tb = await tb.finalizeForPayment(companyId, _ => {})

    checkExpectedPrice(tb, options.expectedPrice)

    // Return the transaction
    const txn = tb.build({type: transactionType || 'routePassPurchase'})

    if (options.postTransactionHook && typeof options.postTransactionHook === 'function') {
      await options.postTransactionHook(transaction)
    }

    return txn
  })
}

export const prepareRoutePassRefund = options => async transaction => {
  const {db, models, credentials, transactionItem, routePass} = options
  TransactionError.assert(
    transactionItem.itemId === routePass.id,
    `This transaction item does not relate to this route pass`
  )
  TransactionError.assert(
    transactionItem.debit <= 0,
    `This transaction item has debit > 0, and thus is unlikely to relate to a route pass purchase`
  )
  TransactionError.assert(
    routePass.status === 'valid' || routePass.status === 'void',
    `Only valid or void route passes can be refunded. This route pass is [${routePass.status}]`
  )

  const priceAfterDiscount = +transactionItem.credit - _.get(routePass, 'notes.discountValue', 0)

  // Find the payment item tied to the route pass purchase transaction
  const paymentItem = await models.TransactionItem.find(
    {
      where: {
        itemType: 'payment',
        transactionId: transactionItem.transactionId,
      }
    },
    { transaction }
  )

  const payment = await models.Payment.findById(paymentItem.itemId, { transaction })
  const stripeRefundInfo = await generateRefundInfo(
    payment,
    priceAfterDiscount,
    payment.options && payment.options.isMicro,
    `Refund:instance=${process.env.TEST_IDEMPOTENCY},routePassId=${routePass.id}`
  )

  let transactionBuilder = new TransactionBuilder({
    db, models, transaction, dryRun: false,
    committed: true,
    creator: {
      type: credentials.scope,
      id: credentials.adminId || credentials.email
    }
  })
  transactionBuilder.description = `Refund Payment for route pass ${routePass.id}`

  transactionBuilder.transactionItemsByType.routePass = [{
    itemType: 'routePass',
    itemId: routePass.id,
    debit: priceAfterDiscount,
    notes: {refundedTransactionId: transactionItem.transactionId},
  }]

  await routePass.update({status: 'refunded'}, {transaction})

  transactionBuilder.undoFunctions.push(
    (t) => routePass.update({status: 'valid'}, {transaction: t})
  )
  transactionBuilder = await Payment.refund(transactionBuilder,
    null, null, routePass.companyId, stripeRefundInfo)

  const [dbTransactionInstance, undoFn] = await transactionBuilder.build({type: 'refundPayment'})

  return [dbTransactionInstance, undoFn, stripeRefundInfo]
}

export async function prepareTicketRefund (options) {
  let {targetAmt, ticketId, credentials, db, m} = options
  assert(db && m && targetAmt && ticketId && credentials)

  return await db.transaction(async (t) => {
    // ensure that all tickets are valid
    var ticket = await m.Ticket.findById(ticketId, {
      include: [{
        as: "boardStop",
        model: m.TripStop,
        include: [m.Trip]
      }],
      transaction: t
    })

    // check if ticket is eligible for refunds
    TransactionError.assert(ticket.status === 'valid' || ticket.status === 'void',
      "Trying to refund a non-valid ticket")

    // Find the associated company, check if user is authorised to trigger refund
    var [company] = await db.query(
      `
      SELECT "transportCompanies"."id"
      FROM tickets
        INNER JOIN "tripStops"
          ON "tickets"."boardStopId" = "tripStops"."id"
        INNER JOIN "trips"
          ON "tripStops"."tripId" = "trips".id
        INNER JOIN "routes"
          ON "trips"."routeId" = "routes".id
        INNER JOIN "transportCompanies"
          ON "transportCompanies"."id" = "routes"."transportCompanyId"
      WHERE "tickets"."id" = :ticketId
      `, {
        transaction: t,
        type: db.QueryTypes.SELECT,
        replacements: {
          ticketId: ticket.id
        }
      })
    auth.assertAdminRole(credentials, 'refund', company.id)

    // Reverse search from ticket id, get transaction entry + related transactionItems
    var ticketSale = await m.TransactionItem.find({
      where: {
        itemId: ticket.id,
        itemType: 'ticketSale'
      },
      include: [{
        model: m.Transaction,
        include: [m.TransactionItem]
      }],
      transaction: t
    })

    TransactionError.assert(ticketSale, 'Cannot refund/void a ticket that was not sold - ticketSale not found')

    var txn = ticketSale.transaction
    const relatedTIs = txn.transactionItems

    let transactionItemsByType = _.groupBy(relatedTIs, 'itemType')

    // Attempt to refund only if some some payment was made
    assert(transactionItemsByType.payment)
    assert.strictEqual(transactionItemsByType.payment.length, 1)
    TransactionError.assert(transactionItemsByType.payment[0].debit > 0,
      'No payment was made for this transaction')

    // Check for previous partial refunds for this ticket
    var refundTI = await m.TransactionItem.findAll({
      where: {
        itemId: ticket.id,
        itemType: 'ticketRefund'
      },
      include: [{
        model: m.Transaction,
        where: {committed: true},
        attributes: [],
      }],
      attributes: ['debit'],
      transaction: t
    })

    const previouslyRefunded = _.sum(refundTI.map(ti => ti.debit))

    const priceAfterDiscount = +ticketSale.credit - _.get(ticket, 'notes.discountValue', 0)

    // Enforce all or nothing refund
    TransactionError.assert(Math.abs(targetAmt - priceAfterDiscount) < 0.0001,
      `Current implementation requires requested refund to equal ticket value after discounts`)

    const possibleRefundAmt = priceAfterDiscount - previouslyRefunded

    // can't refund more than a ticket is worth
    TransactionError.assert(possibleRefundAmt >= targetAmt,
      'Refund requested causes total refunded to exceed allowed refund amount')

    let transactionBuilder = new TransactionBuilder({
      db, models: m, transaction: t, dryRun: false,
      committed: true,
      creator: {
        type: credentials.scope,
        id: credentials.adminId || credentials.email
      }
    })
    transactionBuilder.postTransactionHooks.push(transactionBuilder._saveChangesToTickets)
    transactionBuilder.description = `Refund Payment for ticket ${ticket.id}`

    transactionBuilder.transactionItemsByType.ticketRefund = [{
      itemType: 'ticketRefund',
      itemId: ticket.id,
      debit: targetAmt,
      notes: {refundedTransactionId: ticketSale.transactionId},
    }]

    ticket = await ticket.update({status: 'refunded'}, {transaction: t})

    transactionBuilder.undoFunctions.push(
      (t) => ticket.update({status: 'valid'}, {transaction: t})
    )
    const stripeRefundInfo = await generateRefundInfo(
      await m.Payment.findById(transactionItemsByType.payment[0].itemId),
      targetAmt,
      relatedTIs[0].options && relatedTIs[0].options.isMicro,
      `Refund:instance=${process.env.TEST_IDEMPOTENCY},ticketId=${ticket.id}`
    )

    transactionBuilder = await Payment.refund(transactionBuilder,
      null, ticket.id, company.id, stripeRefundInfo)

    const [dbTransactionInstance, undoFn] = await transactionBuilder.build({type: 'refundPayment'})

    return [dbTransactionInstance, undoFn, stripeRefundInfo]
  })
}

async function generateRefundInfo (paymentItem, amount, isMicro, idempotencyKey) {
  var charge = await Payment.retrieveCharge(paymentItem.paymentResource)
  var balanceAmtCents = charge.amount - charge.amount_refunded
  var refundAmtCents = Math.round(amount * 100)

  const isLocalAndNonAmex = Payment.isLocalAndNonAmex(charge.source)

  TransactionError.assert(balanceAmtCents >= (amount * 100) - 0.1, `Requested refund exceeds amount paid for ticket`)
  var updatedBalance = balanceAmtCents - refundAmtCents
  var processingFee = (Payment.calculateAdminFeeInCents(balanceAmtCents, isMicro, isLocalAndNonAmex) -
    Payment.calculateAdminFeeInCents(updatedBalance, isMicro, isLocalAndNonAmex)) / 100

  return {
    processingFee, charge, isMicro, balanceAmtCents,
    amount, idempotencyKey
  }
}

function runOrderChecks (tb, checkOptions) {
  const tripsById = tb.tripsById
  const tripOrders = tb.lineItems

  _(tripsById).each((trip, tripId) => {
    TransactionError.assert(trip.isRunning, `Trip ${tripId} has been cancelled`)
  })
  _(tripOrders).each((tripOrder) => {
    const dbTrip = tripsById[tripOrder.tripId]
    if (checkOptions.bookingWindow) {
      checkValidBookingWindow()(dbTrip, tripOrder)
    } else {
      checkValidTripStop()(dbTrip, tripOrder)
    }
    if (checkOptions.noDuplicates) {
      checkNoDuplicates()(dbTrip, tripOrder)
    }
  })

  // FIXME: when we support simultaneous payment to multiple companies
  TransactionError.assert.strictEqual(
    _(tripsById).values().map(v => v.transportCompanyId).uniq().size(),
    1,
    'Payment to multiple companies is not yet supported'
  )
}

function checkExpectedPrice (tb, price) {
  if (price === null) {
    return
  }

  price = parseFloat(price)

  const paymentItem = tb.transactionItemsByType.payment[0]

  TransactionError.assert(
    Math.abs(price - parseFloat(paymentItem ? paymentItem.debit : 0)) < 0.001,
    "The price has changed since you last viewed it"
  )
}

function absorbSmallPayments (tb) {
  const excess = tb._excessCredit()

  if (excess > 0 && excess * 100 <= Payment.minTransactionChargeInCents()) {
    const clone = new TransactionBuilder(tb)


    const outstandingAmountsList = outstandingAmounts(clone.items)
    const outstandingAmountsById = _.fromPairs(_.zip(
      clone.items.map(item => item.ticket.id),
      outstandingAmountsList
    ))

    updateTicketsWithDiscounts(clone.items, '[absorb-small-payments]', outstandingAmountsList, false)

    clone.transactionItemsByType.discount = clone.transactionItemsByType.discount || []
    clone.transactionItemsByType.discount.push({
      /* Absorb all transaction fees if total amount falls below minimum */
      itemType: 'discount',
      debit: excess,
      discount: {
        description: 'Transaction fee absorbed',
        code: '',
        userOptions: null,
        discountAmounts: outstandingAmountsById,
        refundAmounts: outstandingAmountsById,
        promotionParams: null,
        promotionId: null
      }
    })
    return clone
  } else {
    return tb
  }
}

/* Convert transaction status to "failed"
   For use when Stripe fails
*/
export async function cancelSale (connection, transactionId) {
  var [db, m] = connection

  var txnIncludes = [{
    model: m.TransactionItem,
    include: [
      {model: m.Payment, as: "payment"},
      {model: m.Account, as: "account"},
      {model: m.Transfer, as: "transfer"},
      {model: m.Ticket, as: "ticketSale"},
      // {model: m.Voucher, as:"ticket"},
      // {model: m.PromoCode, as:"ticket"},
    ]
  }]

  return await db.transaction({
    isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE
  }, async (t) => {
    // check txn belongs to user
    var dbTxn = await m.Transaction.findById(transactionId, {
      include: txnIncludes,
      transaction: t
    })

    if (dbTxn === null || dbTxn.committed === false) {
      throw new TransactionError("Transaction not found!")
    }

    // uncommit, then disable the tickets
    dbTxn.set("committed", false)
    var ticketSale = _.filter(dbTxn.transactionItems, {itemType: "ticketSale"})
    if (!ticketSale.every(item => item.ticketSale.status === "valid")) {
      throw new Error("Not all tickets are committed")
    }
    var changes = ticketSale.map(item => {
      item.ticketSale.set("status", "failed")
      return item.ticketSale.save({transaction: t})
    })
    changes.push(dbTxn.save({transaction: t, include: txnIncludes}))
    await Promise.all(changes)
    return dbTxn.toJSON()
  })
}

/**
 *  @param connection [db, models]
    @param transaction The Transaction object.
    This function will check the transaction for payment
    objects and charge stripe according to them.
    @param stripeToken Stripe token for payment
    @param tokenIat The iat: field in the session token.
                  Why? To ensure one-at-a-time bookings for
                  bookings in the same session.
*/
export async function chargeSale (options) {
  // var itemDescription = "Beeline: Booking ID 1304. 10 tickets"
  // Group the transaction items first
  try {
    // [db, m], transaction, stripeToken, tokenIat
    assert(options.models)
    assert(options.transaction)
    // assert(options.stripeToken);
    assert(options.paymentDescription)

    var {models: m, transaction, tokenIat, paymentDescription, stripeToken, customerId, sourceId} = options

    assert(stripeToken || (customerId && sourceId), 'Either stripe token or saved payment info should be set')

    var txnGroups = _.groupBy(transaction.transactionItems, "itemType")

    assert.equal(txnGroups.payment.length, 1, "An internal server error occurred.")
    var paymentValue = txnGroups.payment[0].debit

    assert.equal(txnGroups.transfer.length, 1, "An internal server error occurred.")
    var busCompanyId = txnGroups.transfer[0].transfer.transportCompanyId

    var companyInfo = await m.TransportCompany.findById(busCompanyId)
    assert(companyInfo, "An internal server error occurred.")

    var stripeCompanyId = companyInfo.get(
      stripeIsLive ? "clientId" : "sandboxId",
      {raw: true}
    )
    assert(stripeCompanyId, "An internal server error occurred.")

    var idempotencyKey = `instance=${process.env.TEST_IDEMPOTENCY},` +
      `bookingId=${transaction.id},session=${tokenIat}`
    // var paymentDescription = `Beeline: TxnID ${transaction.id}, ` +
    //     `${companyInfo.name}, ${txnGroups.ticketSale.length} ticket(s)`;

    // Clean up the statement descriptor according to stripe rules
    var statementDescriptor = `${companyInfo.name.substr(0, 10)},Ref#${transaction.id}`
      .replace(/[<>"']/g, '') // no <>"'
      .substr(0, 22) // 22 characters max

    var chargeResult

    if (paymentValue === '0.00') {
      chargeResult = {id: null}
    } else if (options.stripeToken) {
      chargeResult = await Payment.chargeCard({
        value: paymentValue,
        description: paymentDescription,
        statement_descriptor: statementDescriptor,
        destination: stripeCompanyId,
        idempotencyKey: idempotencyKey,
        source: stripeToken
      })
    } else if (options.customerId && options.sourceId) {
      chargeResult = await Payment.chargeCard({
        value: paymentValue,
        description: paymentDescription,
        statement_descriptor: statementDescriptor,
        destination: stripeCompanyId,
        idempotencyKey: idempotencyKey,
        customer: customerId,
        source: sourceId
      })
    }

    // store charge result in database
    await m.Payment.update({
      paymentResource: chargeResult.id,
      data: chargeResult,
      options: {isMicro: Payment.isMicro(chargeResult.amount)}
    }, {
      where: {id: txnGroups.payment[0].payment.id},
      fields: ["paymentResource", "data", "options"]
    })
  } catch (error) {
    // store the reason for failure in the database
    let models = options.models
    let transaction = options.transaction
    let txnGroups = _.groupBy(transaction.transactionItems, "itemType")

    await models.Payment.update({
      data: error
    }, {
      where: {id: txnGroups.payment[0].payment.id},
      fields: ["paymentResource", "data", "options"]
    })

    throw new ChargeError(error.message)
  }
}

export function checkValidTrips (tripsById, tripsRequested, perTripChecks) {
  for (var tripId in tripsById) {
    if (!tripsById[tripId].isRunning) {
      throw new TransactionError(`Trip ${tripId} has been cancelled`)
    }
  }
  for (let trip of tripsRequested) {
    for (let check of perTripChecks) {
      check(tripsById[trip.tripId], trip)
    }
  }
}

/**
  * If bookingWindow is truthy, then check booking window.
  * Otherwise it just checks that the tripStops are valid.
  */
export function checkStopsAndBookingWindow (checkBookingWindow, now = Date.now()) {
  return (dbTrip, rqTrip) => {
    // check stops
    let boardStopIndex = dbTrip.tripStops
      .findIndex(ts => ts.id === rqTrip.boardStopId)
    let alightStopIndex = dbTrip.tripStops
      .findIndex(ts => ts.id === rqTrip.alightStopId)

    if (boardStopIndex === -1 || alightStopIndex === -1) {
      throw new TransactionError(`Invalid stop given for trip #${dbTrip.id}`)
    }

    // Whether to check for booking window.
    if (!checkBookingWindow) return

    // Validate the bookingInfo
    let defaultBookingInfo = {windowType: 'stop', windowSize: 0}
    let {error: bookingInfoError, value: bookingInfo} =
      Joi.validate(dbTrip.bookingInfo || {}, Joi.object({
        windowType: Joi.valid(['stop', 'firstStop']).default('stop'),
        windowSize: Joi.number().default(0)
      }).unknown())
    if (bookingInfoError) {
      // FIXME: Warn the operators and tell
      bookingInfo = defaultBookingInfo
    }
    let {windowSize, windowType} = bookingInfo

    // Determine the type of check
    let cutOff = 0

    if (windowType === "firstStop") {
      // check against the first stop
      cutOff = _.min(dbTrip.tripStops.map(ts => ts.time.getTime())) + windowSize
    } else { /* i.e. if windowType === 'stop' */
      // check against the time of the boarding and alighting stop
      let boardStopCutoff = dbTrip.tripStops[boardStopIndex].time.getTime() + windowSize
      let alightStopCutoff = dbTrip.tripStops[alightStopIndex].time.getTime() + windowSize

      cutOff = _.min([boardStopCutoff, alightStopCutoff])
    }

    if (now > cutOff) {
      throw new TransactionError('You may not book this trip later than ' +
        new Date(cutOff).toLocaleTimeString({ timeZone: 'Asia/Singapore' }))
    }
  }
}

export var checkValidTripStop = checkStopsAndBookingWindow(false)
// This is a function to reset the now()
export var checkValidBookingWindow = (...args) => checkStopsAndBookingWindow(true, ...args)

export function checkNoDuplicates () {
  return (dbTrip, rqTrip) => {
    var dbTripTickets = _.flatten(dbTrip.tripStops.map(ts => ts.tickets))

    if (dbTripTickets.some(ticket => (ticket.status === "valid" || ticket.status === 'pending' || ticket.status === 'bidded') && ticket.userId === rqTrip.userId)) {
      throw new TransactionError(`User #${rqTrip.userId} already has a ticket for the trip`)
    }
  }
}

export function checkAvailability ([db, m], tripIds, transaction) {
  return m.Trip.findAll({
    transaction,
    where: {
      id: {$in: tripIds}
    }
  }).then(trips => {
    if (trips.some(t => t.seatsAvailable < 0)) {
      throw new TransactionError("Not enough seats available")
    }
  })
}
