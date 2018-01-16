const {createStripeToken, calculateAdminFeeInCents, isMicro, stripe} = require("../src/lib/transactions/payment")
const {expect} = require("code")
var Lab = require("lab")
export var lab = Lab.script()

lab.experiment("Stripe Micro-transactions", function () {
  function stripeToken () {
    return createStripeToken({
      number: "4242424242424242",
      exp_month: "12",
      exp_year: "2019",
      cvc: "123"
    })
  }

  // XXX: all test credit cards issued by stripe calculate the admin fee
  // using the international rate, so we will not be able to verify the domestic one
  function adminFee (amount) {
    return calculateAdminFeeInCents(amount, isMicro(amount), false)
  }

  lab.test('Stripe rates have not changed', function (done) {
    var saveEnv = process.env.STRIPE_MICRO_RATES

    const STRIPE_MICRO_MIN_CHARGE = parseInt(process.env.STRIPE_MICRO_MIN_CHARGE)
    const STRIPE_MACRO_MIN_CHARGE = parseInt(process.env.STRIPE_MACRO_MIN_CHARGE)

    const STRIPE_MICRO_CHARGE_RATE = parseFloat(process.env.STRIPE_MICRO_CHARGE_RATE)
    const STRIPE_AMEXINTL_CHARGE_RATE = parseFloat(process.env.STRIPE_AMEXINTL_CHARGE_RATE)

    process.env.STRIPE_MICRO_RATES = 'true'
    expect(adminFee(500)).equal(Math.round(500 * STRIPE_MICRO_CHARGE_RATE) + STRIPE_MICRO_MIN_CHARGE)
    expect(adminFee(1500)).equal(Math.round(1500 * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)

    process.env.STRIPE_MICRO_RATES = 'false'
    expect(adminFee(500)).equal(Math.round(500 * STRIPE_AMEXINTL_CHARGE_RATE) + STRIPE_MACRO_MIN_CHARGE)

    process.env.STRIPE_MICRO_RATES = saveEnv
    done()
  })

  lab.test("(Failure => Your stripe microtxn settings are wrong)", {timeout: 50000}, async function () {
    var fee1 = 7.50
    var refund1 = 3.5
    var amount = Math.round(fee1 * 100)
    var application_fee = adminFee(amount)
    var ism = isMicro(amount)
    var token = await stripeToken()

    var chargeDetails = {
      source: token.id,
      description: "Micropayment test #1 payment #1",
      amount,
      currency: "SGD",
      capture: true,
    }

    var stripeCharge = await stripe.charges.create(chargeDetails)

    // Get the balance transaction
    var stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeCharge.balance_transaction)

    expect(stripeBalanceTxn.fee)
      .equal(application_fee)

    // Refund partially...
    var applicationFeeRefund = calculateAdminFeeInCents(Math.round((fee1 - refund1) * 100), ism, false) -
        calculateAdminFeeInCents(Math.round(fee1 * 100), ism, false)

    var stripeRefund = await stripe.refunds.create({
      charge: stripeCharge.id,
      amount: Math.round(refund1 * 100),
    })

    // Check the balance transaction
    stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeRefund.balance_transaction)

    expect(stripeBalanceTxn.fee)
      .equal(applicationFeeRefund)
  })

  lab.test("Standard payment above and refund below µTxn Threshold", {timeout: 50000}, async function () {
    var fee1 = 10.50
    var refund1 = 3.5
    var amount = Math.round(fee1 * 100)
    var application_fee = adminFee(amount)
    var ism = isMicro(amount)
    var token = await stripeToken()

    expect(ism).equal(false)

    var chargeDetails = {
      source: token.id,
      description: "Standard payment test #1 payment #1",
      amount,
      currency: "SGD",
      capture: true,
    }

    var stripeCharge = await stripe.charges.create(chargeDetails)

    // Get the balance transaction
    var stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeCharge.balance_transaction)

    expect(stripeBalanceTxn.fee).equal(application_fee)

    // Refund partially...
    var applicationFeeRefund = calculateAdminFeeInCents(Math.round((fee1 - refund1) * 100), ism, false) -
        calculateAdminFeeInCents(Math.round(fee1 * 100), ism, false)

    var stripeRefund = await stripe.refunds.create({
      charge: stripeCharge.id,
      amount: Math.round(refund1 * 100),
    })

    // Check the balance transaction
    stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeRefund.balance_transaction)

    expect(stripeBalanceTxn.fee).equal(applicationFeeRefund)
  })
})
