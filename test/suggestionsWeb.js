import Lab from "lab"
export const lab = Lab.script()
import { expect } from "code"

import { updateTravelTime } from "../src/lib/endpoints/suggestionsWeb.js"
import _ from "lodash"
import sinon from "sinon"
import jwt from "jsonwebtoken"
import qs from "querystring"

const { models: m } = require("../src/lib/core/dbschema")()
const server = require("../src/index.js")

lab.experiment("Suggestions from the web", function() {
  let sandbox

  lab.beforeEach(async () => {
    sandbox = sinon.sandbox.create()
  })

  lab.afterEach(async () => {
    sandbox.restore()
  })

  lab.test("Unverified suggestion", { timeout: 10000 }, async function() {
    let now = Date.now()
    let email = `test-${now}@example.com`

    let messageEmailURL
    let emailModule = require("../src/lib/util/email")

    // Verify that the email contains certain magic strings
    sandbox.stub(emailModule, "sendMail", options => {
      expect(options.to).equal(email)
      expect(
        options.text.indexOf(
          `https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token=`
        )
      ).not.equal(-1)
      expect(
        options.html.indexOf(
          `https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token&#x3D;`
        )
      ).not.equal(-1)

      const match = options.html.match(
        /(\/suggestions\/web\/verify\?token&#x3D;[-_a-zA-Z0-9.]*)[^-_a-zA-Z0-9.]/
      )

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
      daysOfWeek: {
        Mon: true,
        Tue: false,
        Wed: true,
        Thu: true,
        Fri: false,
        Sat: true,
        Sun: true,
      },
    }

    let suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload,
    })
    expect(suggestResponse.statusCode).to.equal(200)

    let emailSuggestions = await m.Suggestion.findAll({
      where: { email },
    })

    // Because not verified!
    expect(emailSuggestions.length).equal(0)

    // FIXME: check email
    const verifyResponse = await server.inject({
      method: "GET",
      url: messageEmailURL.replace("&#x3D;", "="),
    })

    expect(verifyResponse.statusCode).equal(302) // Redirect to app.beeline

    emailSuggestions = await m.Suggestion.findAll({
      where: { email },
    })

    // Because verified!
    expect(emailSuggestions.length).equal(1)
    expect(emailSuggestions[0].board.coordinates).equal([
      payload.boardLon,
      payload.boardLat,
    ])
    expect(emailSuggestions[0].alight.coordinates).equal([
      payload.alightLon,
      payload.alightLat,
    ])
  })

  lab.test("Verified suggestion", async function() {
    let now = Date.now()
    let email = `test-${now}@example.com`
    let suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email,
        emailVerification: {
          type: "auth0",
          data: jwt.sign(
            { email, email_verified: true },
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
          ),
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        daysOfWeek: {
          Mon: true,
          Tue: false,
          Wed: true,
          Thu: true,
          Fri: false,
          Sat: true,
          Sun: true,
        },
        time: 8999,
        referrer: "ABC",
      },
    })
    expect(suggestResponse.statusCode).to.equal(200)

    let emailSuggestions = await m.Suggestion.findAll({
      where: { email },
    })

    // Because not verified!
    expect(emailSuggestions.length).equal(1)
    expect(emailSuggestions[0].referrer).equal("ABC")
    expect(emailSuggestions[0].daysMask).equal(parseInt('1101101', 2))
  })

  lab.test("Default daysOfWeek is MTWTF", async function() {
    let now = Date.now()
    let email = `test-${now}@example.com`
    let suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email,
        emailVerification: {
          type: "auth0",
          data: jwt.sign(
            { email, email_verified: true },
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
          ),
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        time: 8999,
        referrer: "ABC",
      },
    })
    expect(suggestResponse.statusCode).to.equal(200)

    let emailSuggestions = await m.Suggestion.findAll({
      where: { email },
    })

    expect(emailSuggestions[0].daysMask).equal(parseInt('0011111', 2))
  })

  lab.test(
    "Suggestions are anonymized if accessed by other users",
    async function() {
      const now = Date.now()
      const creatorEmail = `test-${now}@example.com`
      const visitorEmail = `test-${now}-visitor@example.com`

      const creatorToken = jwt.sign(
        { email: creatorEmail, email_verified: true },
        new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
      )

      const visitorToken = jwt.sign(
        { email: visitorEmail, email_verified: true },
        new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
      )

      const suggestResponse = await server.inject({
        method: "POST",
        url: "/suggestions/web",
        payload: {
          email: creatorEmail,
          emailVerification: {
            type: "auth0",
            data: jwt.sign(
              { email: creatorEmail, email_verified: true },
              new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
            ),
          },
          boardLat: 1.381,
          boardLon: 103.81,
          alightLat: 1.389,
          alightLon: 103.8199,
          time: 8999,
          daysOfWeek: {
            Mon: true,
            Tue: false,
            Wed: false,
            Thu: true,
            Fri: false,
            Sat: true,
            Sun: true,
          },
          referrer: "ABC",
        },
      })
      expect(suggestResponse.statusCode).to.equal(200)

      const getResponseAuthorized = await server.inject({
        method: "GET",
        url: `/suggestions/web/${suggestResponse.result.id}`,
        headers: {
          authorization: `Bearer ${creatorToken}`,
        },
      })
      expect(getResponseAuthorized.result.email).equal(creatorEmail)

      const getResponseUnauthorized = await server.inject({
        method: "GET",
        url: `/suggestions/web/${suggestResponse.result.id}`,
        headers: {
          authorization: `Bearer ${visitorToken}`,
        },
      })
      expect(getResponseUnauthorized.result.email).not.equal(creatorEmail)
      expect(getResponseUnauthorized.result.email.indexOf("*****")).least(0)

      const getResponseUnauthenticated = await server.inject({
        method: "GET",
        url: `/suggestions/web/${suggestResponse.result.id}`,
      })
      expect(getResponseUnauthenticated.result.email).not.equal(creatorEmail)
      expect(getResponseUnauthenticated.result.email.indexOf("*****")).least(0)
    }
  )

  lab.test("Similar suggestions", async function() {
    let now = Date.now()
    let email = `test-${now}@example.com`
    let suggestResponse = await server.inject({
      method: "POST",
      url: "/suggestions/web",
      payload: {
        email,
        emailVerification: {
          type: "auth0",
          data: jwt.sign(
            { email, email_verified: true },
            new Buffer(process.env.PUBLIC_AUTH0_SECRET, "base64")
          ),
        },
        daysOfWeek: {
          Mon: true,
          Tue: false,
          Wed: true,
          Thu: true,
          Fri: false,
          Sat: false,
          Sun: true,
        },
        boardLat: 1.381,
        boardLon: 103.81,
        alightLat: 1.389,
        alightLon: 103.8199,
        time: 8999991,
      },
    })
    expect(suggestResponse.statusCode).to.equal(200)

    // Add an entry with a null email
    const suggestion = await m.Suggestion.create({
      board: {
        type: "Point",
        coordinates: [103.810011, 1.381],
      },
      alight: {
        type: "Point",
        coordinates: [103.81988889, 1.389],
      },
      email: null,
      ipAddress: "0.1.2.3",
      time: 999999,
    })

    /**
     *
     * @param {json} query
     * @return {json}
     */
    async function getResponseForSimilarQuery(query) {
      const response = await server.inject({
        url:
          "/suggestions/web/similar?" +
          qs.stringify(query),
      })
      expect(response.statusCode).equal(200)

      return response.result
    }

    /**
     * every, but also checks that the array is nonempty
     * @param {array} m
     * @param {function} f
     * @return {boolean}
     */
    function strictEvery(m, f) {
      return m.length > 0 && _.every(m, f)
    }

    // Check redaction
    expect(_.some(
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
      }),
      s =>
        s.time === 8999991 &&
        s.email.indexOf("*****") !== -1 &&
        s.email.indexOf("test-") === -1
    )).true()

    expect(strictEvery(
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
      }),
      s => (s.email === null || s.email.indexOf("test-") === -1) &&
        s.ipAddress === null
    )).true()

    // Check that limit by time will succeed
    expect(strictEvery(
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
        time: 999999,
        maxTimeDifference: 1000,
      }),
      s =>
        Math.abs(new Date(s.time).getTime() - 999999) <= 1000
    )).true()

    // Check that limit by time anonymity
    expect(strictEvery(
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
        includeAnonymous: false,
      }),
      s => s.email !== null
    )).true()

    // Check that limit by created date works
    expect((
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
        createdSince: new Date(Date.now() + 100).toISOString(),
      })
    ).length).equal(0)
    expect((
      await getResponseForSimilarQuery({
        startLat: 1.381005,
        startLng: 103.81005,
        endLat: 1.389001,
        endLng: 103.8199001,
        createdSince: suggestion.createdAt.toISOString(),
      })
    ).length).equal(1)
  })

  lab.test("updateTravelTime()", { timeout: 5000 }, async function() {
    let suggestion = await m.Suggestion.create({
      board: { type: "Point", coordinates: [103.947466, 1.373081] },
      alight: { type: "Point", coordinates: [103.755615, 1.316429] },
      time: 13 * 3600 * 1000,
    })

    await updateTravelTime(suggestion)

    // Pasir Ris to west coast park by transit
    // at least 1 hr 15 mins
    expect(suggestion.travelTime).least(3600 + 15 * 60)
    expect(suggestion.travelTime).most(7200)
  })
})
