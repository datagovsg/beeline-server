const {createStripeToken, calculateAdminFeeInCents, isMicro, stripe} = require("../src/lib/transactions/payment")
const {expect} = require("code")
let Lab = require("lab")
export const lab = Lab.script()

lab.experiment("Stripe Micro-transactions", function () {
  const stripeToken = () => {
    return createStripeToken({
      number: "4242424242424242",
      exp_month: "12",
      exp_year: "2019",
      cvc: "123",
    })
  }

  // XXX: all test credit cards issued by stripe calculate the admin fee
  // using the international rate, so we will not be able to verify the domestic one
  const adminFee = (amount) => {
    return calculateAdminFeeInCents(amount, isMicro(amount), false)
  }

  lab.test('Stripe rates have not changed', function (done) {
    let saveEnv = process.env.STRIPE_MICRO_RATES

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
    let fee1 = 7.50
    let refund1 = 3.5
    let amount = Math.round(fee1 * 100)
    let applicationFee = adminFee(amount)
    let ism = isMicro(amount)
    let token = await stripeToken()

    let chargeDetails = {
      source: token.id,
      description: "Micropayment test #1 payment #1",
      amount,
      currency: "SGD",
      capture: true,
    }

    let stripeCharge = await stripe.charges.create(chargeDetails)

    // Get the balance transaction
    let stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeCharge.balance_transaction)

    expect(stripeBalanceTxn.fee)
      .equal(applicationFee)

    // Refund partially...
    let applicationFeeRefund = calculateAdminFeeInCents(Math.round((fee1 - refund1) * 100), ism, false) -
        calculateAdminFeeInCents(Math.round(fee1 * 100), ism, false)

    let stripeRefund = await stripe.refunds.create({
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
    let fee1 = 10.50
    let refund1 = 3.5
    let amount = Math.round(fee1 * 100)
    let applicationFee = adminFee(amount)
    let ism = isMicro(amount)
    let token = await stripeToken()

    expect(ism).equal(false)

    let chargeDetails = {
      source: token.id,
      description: "Standard payment test #1 payment #1",
      amount,
      currency: "SGD",
      capture: true,
    }

    let stripeCharge = await stripe.charges.create(chargeDetails)

    // Get the balance transaction
    let stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeCharge.balance_transaction)

    expect(stripeBalanceTxn.fee).equal(applicationFee)

    // Refund partially...
    let applicationFeeRefund = calculateAdminFeeInCents(Math.round((fee1 - refund1) * 100), ism, false) -
        calculateAdminFeeInCents(Math.round(fee1 * 100), ism, false)

    let stripeRefund = await stripe.refunds.create({
      charge: stripeCharge.id,
      amount: Math.round(refund1 * 100),
    })

    // Check the balance transaction
    stripeBalanceTxn = await stripe.balance
      .retrieveTransaction(stripeRefund.balance_transaction)

    expect(stripeBalanceTxn.fee).equal(applicationFeeRefund)
  })
})
