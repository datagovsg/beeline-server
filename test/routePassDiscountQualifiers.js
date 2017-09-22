import Lab from 'lab'
export const lab = Lab.script()

import {expect} from 'code'
import dateformat from 'dateformat'

import {
  qualifyingFunctions
} from '../src/lib/promotions/functions/routePassDiscountQualifiers'

const {
  limitByCompany,
  limitByPurchaseDate,
  limitByRouteTags,
  n4m
} = qualifyingFunctions

lab.experiment("RoutePass discount qualifyingFunctions", {timeout: 10000}, function () {
  lab.test("limitByCompany", async () => {
    const params = {companyId: 12345}
    const check = limitByCompany(params)
    const unfiltered = [{companyId: 12345}, {companyId: 54321}]
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].trip).to.equal(unfiltered[0].trip)
  })

  lab.test("limitByRouteTags", async () => {
    const check = limitByRouteTags({
      tags: ['some']
    })
    const unfiltered = [{ tags: ['none'] }, { tags: ['some'] }]
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].trip).to.equal(unfiltered[1].trip)
  })

  // FIXME: this is a clone of the one at ticketDiscountQualifiers
  lab.test("limitByPurchaseDate", async () => {
    const today = new Date()

    const dateToParams = (startOffset, endOffset) => ({
      startDate: dateformat(
        new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate() + startOffset,
        ),
        'yyyy-mm-dd'
      ),
      endDate: dateformat(
        new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate() + endOffset,
        ),
        'yyyy-mm-dd'
      ),
    })
    /*
    If start = D+<startOffset> and end = D+endOffset,
    the array after checking should have length <expectedLength>
    */
    const check = (startOffset, endOffset, expectedLength) => {
      const fn = limitByPurchaseDate(dateToParams(startOffset, endOffset))
      expect(fn([1, 2, 3])).length(expectedLength)
    }

    // All succeed
    check(0, 0, 3)
    check(-1, 1, 3)
    check(-1, 0, 3)
    check(0, 1, 3)

    // All fail
    check(1, -1, 0) // inverted dates
    check(-1, -2, 0) // before today
    check(1, 2, 0) // after today
  })

  lab.test("n4m", async () => {
    let params, check, filtered
    const unfiltered = mockBalances(7.31, 5.27, 6.98, 4.21, 6.52)
    params = {n: 5, m: 4}
    check = n4m(params)
    filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].price).to.equal(unfiltered[3].price)
    params = {n: 2, m: 1}
    check = n4m(params)
    filtered = check(unfiltered, {})
    expect(filtered).to.have.length(2)
    expect(filtered[0].price).to.equal(unfiltered[3].price)
    expect(filtered[1].price).to.equal(unfiltered[1].price)
  })
})

function mockBalances (...prices) {
  return prices.map(balance => ({balance}))
}
