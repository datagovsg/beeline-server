import Lab from 'lab'
export const lab = Lab.script()

import {expect} from 'code'

import {distribute} from '../src/lib/transactions/payment'

import {
  discountingFunctions,
  refundingFunctions
} from '../src/lib/promotions/functions/discountRefunds'

const {
  childRate,
  simpleRate,
  simpleFixed,
  flatPrice,
  tieredRateByQty,
  tieredFixedByQty,
  tieredRateByTotalValue,
  tieredFixedByTotalValue,
  freeTicket,
  fixedTransactionPrice,
} = discountingFunctions

const {
  refundDiscountedAmt,
  refundOriginalAmt,
  refundAverageAmt
} = refundingFunctions

lab.experiment("discountingFunctions", {timeout: 10000}, function () {
  lab.test("childRate", async () => {
    const check = childRate()
    const prices = [7.31, 5.27, 6.98, 4.21, 6.52]
    const items = prices.map(price => ({
      trip: {
        price: price.toFixed(2),
        priceF: price,
        bookingInfo: {
          childTicketPrice: 1,
        }
      },
      item: {child: true},
      price
    }))
    const expected = prices.map(p => p - 1)
    const actual = check(items, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("simpleRate", async () => {
    const params = {rate: 0.2}
    const check = simpleRate(params)
    const items = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const expected = [1.46, 1.05, 1.40, 0.84, 1.30]
    const actual = check(items, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("simpleFixed", async () => {
    const params = {fixed: 6}
    const check = simpleFixed(params)
    const items = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const expected = [6, 5.27, 6, 4.21, 6]
    const actual = check(items, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("flatPrice", async () => {
    const params = {price: 6}
    const check = flatPrice(params)
    const items = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const expected = [1.31, 0, 0.98, 0, 0.52]
    const actual = check(items, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("fixedTransactionPrice", async () => {
    const params = {price: 20}
    const check = fixedTransactionPrice(params)
    const prices = [7.31, 5.27, 6.98, 4.21, 6.52]
    const totalValue = prices.reduce((a, b) => a + b, 0)
    const items = mockPrices.apply(null, prices)
    const expected = distribute(totalValue - params.price, prices)
    const actual = check(items, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("tieredRateByQty", async () => {
    const params = {schedule: [[5, 0.2], [6, 0.3]]}
    const check = tieredRateByQty(params)
    const orderDiscount = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const orderDiscount2 = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52, 8.40)
    const orderDiscount3 = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52, 8.40, 8.40)
    const orderNoDiscount = mockPrices(7.31, 5.27, 6.98, 4.21)
    const expectDiscount = [1.46, 1.05, 1.40, 0.84, 1.30]
    const expectDiscount2 = [2.19, 1.58, 2.09, 1.26, 1.96, 2.52]
    const expectDiscount3 = [2.19, 1.58, 2.09, 1.26, 1.96, 2.52, 2.52]
    const expectNoDiscount = [0, 0, 0, 0]
    const actualDiscount = check(orderDiscount, {})
    const actualDiscount2 = check(orderDiscount2, {})
    const actualDiscount3 = check(orderDiscount3, {})
    const actualNoDiscount = check(orderNoDiscount, {})
    expect(JSON.stringify(actualDiscount)).to.equal(JSON.stringify(expectDiscount))
    expect(JSON.stringify(actualDiscount2)).to.equal(JSON.stringify(expectDiscount2))
    expect(JSON.stringify(actualDiscount3)).to.equal(JSON.stringify(expectDiscount3))
    expect(JSON.stringify(actualNoDiscount)).to.equal(JSON.stringify(expectNoDiscount))
  })

  lab.test("tieredFixedByQty", async () => {
    const params = {schedule: [[5, 5]]}
    const check = tieredFixedByQty(params)
    const orderDiscount = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const orderNoDiscount = mockPrices(7.31, 5.27, 6.98, 4.21)
    const expectDiscount = [1, 1, 1, 1, 1]
    const expectNoDiscount = [0, 0, 0, 0]
    const actualDiscount = check(orderDiscount, {})
    const actualNoDiscount = check(orderNoDiscount, {})
    expect(JSON.stringify(actualDiscount)).to.equal(JSON.stringify(expectDiscount))
    expect(JSON.stringify(actualNoDiscount)).to.equal(JSON.stringify(expectNoDiscount))
  })

  lab.test("tieredRateByTotalValue", async () => {
    const params = {schedule: [[30, 0.2]]}
    const check = tieredRateByTotalValue(params)
    const orderDiscount = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const orderNoDiscount = mockPrices(6.31, 5.27, 6.98, 4.21, 6.52)
    const expectDiscount = [1.46, 1.05, 1.40, 0.84, 1.30]
    const expectNoDiscount = [0, 0, 0, 0, 0]
    const actualDiscount = check(orderDiscount, {})
    const actualNoDiscount = check(orderNoDiscount, {})
    expect(JSON.stringify(actualDiscount)).to.equal(JSON.stringify(expectDiscount))
    expect(JSON.stringify(actualNoDiscount)).to.equal(JSON.stringify(expectNoDiscount))
  })

  lab.test("tieredFixedByTotalValue", async () => {
    const params = {schedule: [[30, 5]]}
    const check = tieredFixedByTotalValue(params)
    const orderDiscount = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const orderNoDiscount = mockPrices(6.31, 5.27, 6.98, 4.21, 6.52)
    const expectDiscount = [1, 1, 1, 1, 1]
    const expectNoDiscount = [0, 0, 0, 0, 0]
    const actualDiscount = check(orderDiscount, {})
    const actualNoDiscount = check(orderNoDiscount, {})
    expect(JSON.stringify(actualDiscount)).to.equal(JSON.stringify(expectDiscount))
    expect(JSON.stringify(actualNoDiscount)).to.equal(JSON.stringify(expectNoDiscount))
  })

  lab.test("freeTicket", async () => {
    const check = freeTicket()
    const order = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    const expects = [7.31, 5.27, 6.98, 4.21, 6.52]
    const actual = check(order, {})
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expects))
  })
})

lab.experiment("refundingFunctions", function () {
  lab.test("refundDiscountedAmt", async () => {
    const discountedAmt = [1.46, 1.05, 1.40, 0.84, 1.30]
    const expected = [1.46, 1.05, 1.40, 0.84, 1.30]
    const actual = refundDiscountedAmt({}, {}, discountedAmt)
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("refundOriginalAmt", async () => {
    const discountedAmt = [1.46, 1.05, 1.40, 0.84, 1.30]
    const expected = [0, 0, 0, 0, 0]
    const actual = refundOriginalAmt({}, {}, discountedAmt)
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  lab.test("refundAverageAmt", async () => {
    const discountedAmt = [1.46, 1.05, 1.40, 0.84, 1.30]
    const expected = [1.21, 1.21, 1.21, 1.21, 1.21]
    const actual = refundAverageAmt({}, {}, discountedAmt)
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })
})

function mockPrices (...prices) {
  return prices.map(price => ({price}))
}
