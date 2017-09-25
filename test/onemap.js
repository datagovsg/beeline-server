const Lab = require("lab")
const lab = exports.lab = Lab.script()

import {expect}  from "code"
import _ from 'lodash'

const server = require("../src/index.js")

async function request () {
  const response = await server.inject({
    path: '/onemap/revgeocode?' + querystring.stringify({
      location: '1.336434280186183,103.8256072998047',
      otherFeatures: 'y',
    })
  })

  expect(response.data.GeocodeInfo).exist()
  expect(response.data.GeocodeInfo[0].LONGITUDE).exist()
}

lab.experiment("OneMap functions succeed", function () {

  lab.test("Onemap Revgeocode", async function (done) {
    request() // should be a fresh request
    request() // token should be cached
  })
})
