import {TransactionBuilder} from './builder'
import _ from 'lodash'
import axios from 'axios'

export var publicKey = process.env.STRIPE_PK
export var cid = process.env.STRIPE_CID
export var sk = process.env.STRIPE_SK

export var stripe = require("stripe")(sk)

const STRIPE_MICRO_MIN_CHARGE = parseInt(process.env.STRIPE_MICRO_MIN_CHARGE)
const STRIPE_MACRO_MIN_CHARGE = parseInt(process.env.STRIPE_MACRO_MIN_CHARGE)

const STRIPE_MICRO_CHARGE_RATE = parseFloat(process.env.STRIPE_MICRO_CHARGE_RATE)
const STRIPE_LOCAL_CHARGE_RATE = parseFloat(process.env.STRIPE_LOCAL_CHARGE_RATE)
const STRIPE_AMEXINTL_CHARGE_RATE = parseFloat(process.env.STRIPE_AMEXINTL_CHARGE_RATE)

export function isLocalAndNonAmex (source) {
  return source.country === 'SG' && source.brand !== 'American Express'
}

export async function chargeCard (options) {
  const source = options.customer
    ? await stripe.customers.retrieveCard(options.customer, options.source)
    : (await stripe.tokens.retrieve(options.source)).card

  var amount = Math.round(options.value * 100)
  var application_fee = calculateAdminFeeInCents(amount, isMicro(amount), isLocalAndNonAmex(source))

  var chargeDetails = _.defaults(_.omit(options, ['value', 'idempotencyKey']), {
    amount,
    application_fee,
    currency: "SGD",
    capture: true,
  })

  // // Stripe doesn't accept empty option
  var chargePromise = options.idempotencyKey
    ? stripe.charges.create(chargeDetails, {idempotency_key: options.idempotencyKey})
    : stripe.charges.create(chargeDetails)

  return chargePromise.then((charge) => {
    if (!charge.transfer) return charge

    return stripe.transfers.retrieve(charge.transfer)
      .then((transfer) => {
        charge.transfer = transfer
        return charge
      }, () => {
        /* Ooops some problem retrieving the transfer, but not fatal, so let it continue */
        return charge
      })
  })
}

export function refundCharge (chargeId, value, idempotencyKey) {
  // Actual Refund is process here
  return stripe.refunds.create({
    charge: chargeId, // charge ID to be indicated
    amount: Math.round(value * 100),
    refund_application_fee: false,
    reverse_transfer: true
  }, {
    idempotency_key: idempotencyKey
  })
}

export function retrieveTransaction (transactionId) {
  return stripe.balance.retrieveTransaction(transactionId)
}

export function retrieveCharge (chargeId) {
  return stripe.charges.retrieve(chargeId)
}

export function createStripeToken (card) {
  return stripe.tokens.create({card})
}

export function saveCustomer (stripeToken) {
  var result = {
    code: 0,
    message: ""
  }
  stripe.customers.create({
    source: stripeToken,
    description: "Save Customer Info"
  }, function (err, customer) {
    if (err) {
      // The card has been declined
      console.log(err)
      result.code = -1
      result.message = "There is some issue while trying to save the customer, please try again later! It the problem persist, please contact our staff."
    } else {
      console.log("Success")
      console.log(customer)
      // get the id for the customer Id
      result.code = 1
      result.message = "Customer Saved Successful"
    }
  })

  return result
}

export function connectAccount (code) {
  return axios.post(
    'https://connect.stripe.com/oauth/token',
    {
      code,
      client_secret: sk,
      grant_type: 'authorization_code',
    }
  )
  .then((response) => response.data)
}

export function isMicro (transactionSum) {
  return transactionSum <= 1000
}

export function calculateAdminFeeInCents (amount, micro, localAndNonAmex) {
  if (amount === 0) return 0
  return (process.env.STRIPE_MICRO_RATES === 'true' && micro)
    ? (Math.round(amount * STRIPE_MICRO_CHARGE_RATE) + STRIPE_MICRO_MIN_CHARGE)
    : localAndNonAmex
      ? (Math.round(amount * STRIPE_LOCAL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
      : (Math.round(amount * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)
}

export function minTransactionChargeInCents () {
  return (process.env.STRIPE_MICRO_RATES === 'true') ? STRIPE_MICRO_MIN_CHARGE : STRIPE_MACRO_MIN_CHARGE
}

export async function refund (tb, previousTransactionItem, previousTicketId, companyId, refundInfo) {
  const {models, transaction} = tb
  const clone = new TransactionBuilder(tb)

  clone.transactionItemsByType.transfer = clone.transactionItemsByType.transfer || []
  clone.transactionItemsByType.refundPayment = clone.transactionItemsByType.refundPayment || []
  clone.transactionItemsByType.account = clone.transactionItemsByType.account || []

  // Stripe refund application fee
  clone.transactionItemsByType.transfer.push({
    transfer: {
      thirdParty: "stripe",
      incoming: refundInfo.processingFee
    },
    itemType: "transfer",
    debit: refundInfo.processingFee
  })
  // Operator send funds to us
  clone.transactionItemsByType.transfer.push({
    transfer: {
      transportCompanyId: companyId,
      incoming: refundInfo.amount
    },
    itemType: "transfer",
    debit: refundInfo.amount
  })
  // We send payments to user
  clone.transactionItemsByType.refundPayment.push({
    refundPayment: {
      outgoing: refundInfo.amount,
      paymentResource: null,
      data: null,
    },
    itemType: "refundPayment",
    credit: refundInfo.amount
  })

  // Revenue account for xfers from operator and Stripe
  var [upstreamRefundsAccount] = await models.Account.findOrCreate({
    where: {
      name: "Upstream Refunds"
    },
    defaults: {
      name: "Upstream Refunds"
    },
    transaction
  })
  clone.transactionItemsByType.account.push({
    itemType: "account",
    itemId: upstreamRefundsAccount.id,
    credit: refundInfo.amount + refundInfo.processingFee
  })
  return clone
}

/**
 * Given an amount to distribute,
 * and prices of tickets, return a list of amounts to discount
 * each ticket by, whilst ensuring that:
 *
 * 1. Total discounted amount after rounding is still equal
 *    to the credits available
 * 2. Credits are distributed roughly proportionally to prices.
 */
export function distribute (amount, prices) {
  const pricesCents = prices.map(p => Math.round(p * 100))
  const totalPriceCents = _.sum(pricesCents)
  const discountAmountCents = Math.min(totalPriceCents, Math.round(amount * 100))

  if (totalPriceCents === 0 || amount === 0) {
    return new Array(prices.length).fill(0)
  }

  // Weighted average (note: there might be rounding errors)
  const discountValuesCents = pricesCents
    .map(price => Math.round(price / totalPriceCents * discountAmountCents))
  let currentSum = _.sum(discountValuesCents)
  while (currentSum < discountAmountCents) {
    currentSum++
    for (var i = 0; i < discountValuesCents.length; i++) {
      if (discountValuesCents[i] < pricesCents[i]) {
        discountValuesCents[i]++
        break
      }
    }
  }
  while (currentSum > discountAmountCents) {
    currentSum--
    for (i = 0; i < discountValuesCents.length; i++) {
      if (discountValuesCents[i] > 0) {
        discountValuesCents[i]--
        break
      }
    }
  }

  return discountValuesCents.map(v => v / 100)
}
