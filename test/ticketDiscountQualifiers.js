import Lab from 'lab'
export const lab = Lab.script()

import {expect} from 'code'
import _ from 'lodash'
import dateformat from 'dateformat'

import {midnightToday} from '../src/lib/util/common'

import {
  qualifyingFunctions
} from '../src/lib/promotions/functions/ticketDiscountQualifiers'

const {
  limitByCompany,
  limitByRoute,
  limitByPurchaseDate,
  limitByTripDate,
  limitByTripDayOfWeek,
  limitByRouteTags,
  freeTickets,
  childTickets,
  n4m,
  limitByMinTicketCount,
} = qualifyingFunctions

lab.experiment("qualifyingFunctions", {timeout: 10000}, function () {
  lab.test("limitByCompany", async () => {
    const params = {companyId: 12345}
    const check = limitByCompany(params)
    const unfiltered = mockTrips(
      {route: {transportCompanyId: 12345} },
      {route: {transportCompanyId: 54321} }
    )
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].trip).to.equal(unfiltered[0].trip)
  })

  lab.test("limitByRoute", async () => {
    const params = {routeIds: [1, 2, 3, 4, 5]}
    const check = limitByRoute(params)
    const unfiltered = mockTrips({routeId: 3}, {routeId: 9})
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].trip).to.equal(unfiltered[0].trip)
  })

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

  lab.test("limitByRouteTags", async () => {
    const check = limitByRouteTags({
      tags: ['some']
    })
    const unfiltered = mockTrips(
    {route: { tags: ['none'] }},
    {route: { tags: ['some'] }},
    {route: { tags: ['some', 'more'] }}
    )
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(2)
    expect(filtered[0].trip).to.equal(unfiltered[1].trip)
    expect(filtered[1].trip).to.equal(unfiltered[2].trip)
  })

  lab.test("limitByTripDate", async () => {
    const now = new Date(2015, 5, 5)
    const params = {startDate: dateformat(now, 'yyyy-mm-dd'), endDate: dateformat(now, 'yyyy-mm-dd')}
    const check = limitByTripDate(params)
    const unfiltered = mockTrips(
      {date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1))},
      {date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 0))},
      {date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1))}
    )
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].trip).to.equal(unfiltered[1].trip)
  })

  lab.test("limitByTripDayOfWeek", async () => {
    const now = new Date(2015, 5, 5)
    const params = _(_.range(0, 7)).map(v => [v, Math.random() > 0.5]).fromPairs().value()
    const check = limitByTripDayOfWeek(params)

    const tripDates = _.range(0, 20)
      .map(day => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay() + day)))

    const unfiltered = mockTrips(...tripDates.map(x => ({date: x})))
    const filtered = check(unfiltered, {})

    for (const day of _.range(0, 20)) {
      if (params[day % 7]) {
        expect(filtered.find(t => t.trip.date.getTime() === tripDates[day].getTime())).exist()
      } else {
        expect(filtered.find(t => t.trip.date.getTime() === tripDates[day].getTime())).not.exist()
      }
    }
  })

  lab.test("freeTickets", async () => {
    const check = freeTickets({})
    const unfiltered = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    let filtered = check(unfiltered, {count: 2})
    expect(filtered).to.have.length(2)
    expect(filtered[0].price).to.equal(unfiltered[3].price)
    expect(filtered[1].price).to.equal(unfiltered[1].price)
    filtered = check(unfiltered, {count: 4})
    expect(filtered).to.have.length(4)
    expect(filtered[2].price).to.equal(unfiltered[4].price)
    expect(filtered[3].price).to.equal(unfiltered[2].price)
  })

  lab.test("childTickets", async () => {
    const check = childTickets({})
    const unfiltered = mockItems({child: false}, {child: true}, {})
    const filtered = check(unfiltered, {})
    expect(filtered).to.have.length(1)
    expect(filtered[0].item).to.equal(unfiltered[1].item)
  })

  lab.test("n4m", async () => {
    let params, check, filtered
    const unfiltered = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
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

  lab.test("limitByMinTicketCount", async () => {
    let params, check, filtered
    const unfiltered = mockPrices(7.31, 5.27, 6.98, 4.21, 6.52)
    params = {n: 4}
    check = limitByMinTicketCount(params)
    filtered = check(unfiltered, {})
    expect(filtered).to.equal(unfiltered)

    params = {n: 7}
    check = limitByMinTicketCount(params)
    filtered = check(unfiltered, {})
    expect(filtered).to.equal([])
  })
})

function mockTrips (...trips) {
  return trips.map(trip => ({trip}))
}

function mockPrices (...prices) {
  return prices.map(price => ({price}))
}

function mockItems (...items) {
  return items.map(item => ({item}))
}
