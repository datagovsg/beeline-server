const {models: m} = require('../src/lib/core/dbschema')()
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import fs from "fs"
import path from 'path'
import _ from 'lodash'

export var lab = Lab.script()

lab.experiment("Assets stuff", function () {
  lab.test('publicHolidays', {timeout: 10000}, async function () {
    await m.Asset.destroy({where: {id: 'PublicHoliday'}})
    await m.Asset.create({
      id: 'PublicHoliday',
      data: fs.readFileSync((path.resolve(__dirname, 'ph.ics')), 'utf8')
    })
    var response = await server.inject({ url: '/publicHolidays'})
    expect(response.statusCode).equal(200)
    expect(response.result.length > 0)
    expect(_.keys(response.result[0]).includes('date'))
    expect(_.keys(response.result[0]).includes('summary'))
  })
})
