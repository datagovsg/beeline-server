var Lab = require("lab")
export var lab = Lab.script()
var {expect} = require("code")
var server = require("../src/index.js")

const {models: m} = require("../src/lib/core/dbschema")()
const {updateTravelTime} = require('../src/lib/endpoints/suggestionsWeb.js')
const _ = require("lodash") // from 'lodash'
const {randomSingaporeLngLat, randomEmail} = require("./test_common")
const sinon = require('sinon')
import jwt from 'jsonwebtoken'
import qs from "querystring"

lab.experiment("Suggestions from the web", function () {
  let sandbox

  lab.beforeEach(async () => {
    sandbox = sinon.sandbox.create()
  })

  lab.afterEach(async () => {
    sandbox.restore()
  })

  lab.test("Unverified suggestion", {timeout: 10000}, async function () {
    var now = Date.now()
    var email = `test-${now}@example.com`

    let messageEmailURL
    let emailModule = require('../src/lib/util/email')

    // Verify that the email contains certain magic strings
    sandbox.stub(emailModule, 'sendMail', (options) => {
      expect(options.to).equal(email)
      expect(options.text.indexOf(`https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token=`)).not.equal(-1)
      console.log(options.html)
      expect(options.html.indexOf(`https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token&#x3D;`)).not.equal(-1)

      const match = options.html.match(/(\/suggestions\/web\/verify\?token&#x3D;[-_a-zA-Z0-9.]*)[^-_a-zA-Z0-9.]/)

      expect(match).exist()
      messageEmailURL = match[1]

      return Promise.resolve(null)
    })

    const payload = {
      email,
      boardLat: 1.381,
      boardLon: 103.81,
      alightLat: 1.389,
      alightLon: 103.8199,
      time: 8999,
    }

    var suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload,
    })
    expect(suggestResponse.statusCode).to.equal(200)

    var emailSuggestions = await m.Suggestion.findAll({
      where: {email}
    })

    // Because not verified!
    expect(emailSuggestions.length).equal(0)

    // FIXME: check email
    const verifyResponse = await server.inject({
      method: 'GET',
      url: messageEmailURL.replace('&#x3D;', '=')
    })

    expect(verifyResponse.statusCode).equal(302) // Redirect to app.beeline

    emailSuggestions = await m.Suggestion.findAll({
      where: {email}
    })

    // Because verified!
    expect(emailSuggestions.length).equal(1)
    expect(emailSuggestions[0].board.coordinates).equal([payload.boardLon, payload.boardLat])
    expect(emailSuggestions[0].alight.coordinates).equal([payload.alightLon, payload.alightLat])
  })

  lab.test("Verified suggestion", async function () {
    var now = Date.now()
    var email = `test-${now}@example.com`
    var suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email,
        emailVerification: {
          type: 'auth0',
          data: jwt.sign(
            {email, email_verified: true},
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        time: 8999,
        referrer: 'ABC'
      }
    })
    expect(suggestResponse.statusCode).to.equal(200)

    var emailSuggestions = await m.Suggestion.findAll({
      where: {email}
    })

    // Because not verified!
    expect(emailSuggestions.length).equal(1)
    expect(emailSuggestions[0].referrer === 'ABC')
    // body...
    // FIXME: check email
  })

  lab.test("Suggestions are anonymized if accessed by other users", async function () {
    const now = Date.now()
    const creatorEmail = `test-${now}@example.com`
    const visitorEmail = `test-${now}-visitor@example.com`

    const creatorToken = jwt.sign(
      {email: creatorEmail, email_verified: true},
      new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))

    const visitorToken = jwt.sign(
      {email: visitorEmail, email_verified: true},
      new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))

    const suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email: creatorEmail,
        emailVerification: {
          type: 'auth0',
          data: jwt.sign(
            {email: creatorEmail, email_verified: true},
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        time: 8999,
        referrer: 'ABC'
      }
    })
    expect(suggestResponse.statusCode).to.equal(200)

    const getResponseAuthorized = await server.inject({
      method: 'GET',
      url: `/suggestions/web/${suggestResponse.result.id}`,
      headers: {
        authorization: `Bearer ${creatorToken}`
      }
    })
    expect(getResponseAuthorized.result.email).equal(creatorEmail)

    const getResponseUnauthorized = await server.inject({
      method: 'GET',
      url: `/suggestions/web/${suggestResponse.result.id}`,
      headers: {
        authorization: `Bearer ${visitorToken}`
      }
    })
    expect(getResponseUnauthorized.result.email).not.equal(creatorEmail)
    expect(getResponseUnauthorized.result.email.indexOf('*****')).least(0)

    const getResponseUnauthenticated = await server.inject({
      method: 'GET',
      url: `/suggestions/web/${suggestResponse.result.id}`,
    })
    expect(getResponseUnauthenticated.result.email).not.equal(creatorEmail)
    expect(getResponseUnauthenticated.result.email.indexOf('*****')).least(0)
  })

  lab.test("Similar suggestions", async function () {
    var now = Date.now()
    var email = `test-${now}@example.com`
    var suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email,
        emailVerification: {
          type: 'auth0',
          data: jwt.sign(
            {email, email_verified: true},
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        time: 8999991,
      }
    })
    expect(suggestResponse.statusCode).to.equal(200)

    // Add an entry with a null email
    await m.Suggestion.create({
      board: {
        type: 'Point',
        coordinates: [103.810011, 1.381],
      },
      alight: {
        type: 'Point',
        coordinates: [103.81988889, 1.389],
      },
      email: null,
      ipAddress: '0.1.2.3',
      time: 999999,
    })

    var similarSuggestionsResponse = await server.inject({
      url: '/suggestions/web/similar?' + qs.stringify({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
      })
    })
    expect(similarSuggestionsResponse.statusCode).equal(200)
    expect(_.some(similarSuggestionsResponse.result, s => s.time === 8999991 &&
      s.email.indexOf('*****') !== -1 &&
      s.email.indexOf('test-') === -1
    )).true()
    expect(_.every(similarSuggestionsResponse.result, s =>
      s.email === null || s.email.indexOf('test-') === -1
    )).true()
    expect(_.every(similarSuggestionsResponse.result, s =>
      s.ipAddress === null
    )).true()
  })


  lab.test("updateTravelTime()", {timeout: 5000}, async function () {
    let suggestion = await m.Suggestion.create({
      board: {type: 'Point', coordinates: [103.947466, 1.373081]},
      alight: {type: 'Point', coordinates: [103.755615, 1.316429]},
      time: (13 * 3600 * 1000),
    })

    await updateTravelTime(suggestion)

    // Pasir Ris to west coast park by transit
    // at least 1 hr 15 mins
    expect(suggestion.travelTime).least(3600 + 15 * 60)
    expect(suggestion.travelTime).most(7200)
  })

  lab.test("Suggestions are limited to owning company", async function () {
    const referrer = 'TestTest'
    let suggestion1 = await m.Suggestion.create({
      board: {type: 'Point', coordinates: randomSingaporeLngLat()},
      alight: {type: 'Point', coordinates: randomSingaporeLngLat()},
      time: (13 * 3600 * 1000),
      referrer
    })
    let suggestion2 = await m.Suggestion.create({
      board: {type: 'Point', coordinates: randomSingaporeLngLat()},
      alight: {type: 'Point', coordinates: randomSingaporeLngLat()},
      time: (13 * 3600 * 1000),
      referrer: referrer + 'Another'
    })

    let company = await m.TransportCompany.create({})
    let admin = await m.Admin.create({email: randomEmail()})
    await admin.addTransportCompany(company.id, {permissions: ['manage-customers']})

    let headers = {
      authorization: `Bearer ${admin.makeToken()}`
    }

    const suggestionResponse1 = await server.inject({
      method: 'GET',
      url: `/companies/${company.id}/suggestions`,
      headers
    })
    // Zero because company has no referrer
    expect(suggestionResponse1.statusCode).equal(200)
    expect(JSON.parse(suggestionResponse1.result).length).equal(0)

    await company.update({referrer})

    const suggestionResponse2 = await server.inject({
      method: 'GET',
      url: `/companies/${company.id}/suggestions`,
      headers
    })
    // Zero because company has no referrer
    expect(suggestionResponse1.statusCode).equal(200)
    expect(JSON.parse(suggestionResponse2.result).length).above(0)

    expect(JSON.parse(suggestionResponse2.result).find(x => x.id === suggestion1.id)).exist()
    expect(JSON.parse(suggestionResponse2.result).find(x => x.id === suggestion2.id)).not.exist()
  })
})
