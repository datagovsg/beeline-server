import * as common from '../src/lib/util/common'
import moment from "moment"
import Lab from "lab"
import {expect} from 'code'

export const lab = Lab.script()

lab.experiment("Common stuff", function () {
  lab.test('formatTime12', {timeout: 2000}, async function () {
    let dateTime = new Date(2016, 8, 1, 13, 8, 2)

    expect(common.formatTime12(dateTime)).equal('\u20071:08 PM')
    expect(common.formatTime12(dateTime.getTime())).equal('\u20071:08 PM')
    expect(common.formatTime12(dateTime.toISOString())).equal('\u20071:08 PM')

    dateTime = new Date(2016, 8, 1, 10, 8, 2)

    expect(common.formatTime12(dateTime)).equal('10:08 AM')
    expect(common.formatTime12(dateTime.getTime())).equal('10:08 AM')
    expect(common.formatTime12(dateTime.toISOString())).equal('10:08 AM')
  })

  lab.test('formatTime24', {timeout: 2000}, async function () {
    let dateTime = new Date(2016, 8, 1, 13, 8, 2)

    expect(common.formatTime24(dateTime)).equal('13:08')
    expect(common.formatTime24(dateTime.getTime())).equal('13:08')
    expect(common.formatTime24(dateTime.toISOString())).equal('13:08')
  })

  lab.test('formatDate', {timeout: 2000}, async function () {
    let dateTime = new Date(2016, 8, 1, 13, 8, 2)

    expect(common.formatDate(dateTime)).equal('1 Sep 2016')
    expect(common.formatDate(dateTime.getTime())).equal('1 Sep 2016')
    expect(common.formatDate(dateTime.toISOString())).equal('1 Sep 2016')
  })

  lab.test('getNextDayInWeek', async function () {
    let date = moment("2018-09-28") // date falls on Friday

    // next Thursday
    expect(common.getNextDayInWeek(moment(date), 4).format("DD MM YYYY")).equal('04 10 2018')
    // next Friday
    expect(common.getNextDayInWeek(moment(date), 5).format("DD MM YYYY")).equal('28 09 2018')
    // next Sunday
    expect(common.getNextDayInWeek(moment(date), 7).format("DD MM YYYY")).equal('30 09 2018')
  })
})
