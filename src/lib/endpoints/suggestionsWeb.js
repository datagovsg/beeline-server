const _ = require("lodash")
const Joi = require("joi")
const common = require("../util/common")
const Boom = require("boom")
const querystring = require('querystring')
import {Buffer} from "buffer"
import axios from 'axios'
import process from 'process'
import jwt from 'jsonwebtoken'
import assert from 'assert'
import path from 'path'
import Handlebars from 'handlebars'
import fs from 'fs'
import * as auth from '../core/auth'
import * as email from '../util/email'
import {anonymizeEmail} from '../util/email'
import {toSVY} from "../util/svy21"
import {NotFoundError, InvalidArgumentError} from '../util/errors'
import {handleRequestWith, assertFound, instToJSONOrNotFound} from '../util/endpoints'
import BlueBird from 'bluebird'

var getModels = common.getModels
var getDB = common.getDB
var defaultErrorHandler = common.defaultErrorHandler

var auth0Secret = new Buffer(process.env.PUBLIC_AUTH0_SECRET || '', 'base64')

/**
**/
export function register (server, options, next) {
  /* Custom authentication scheme that verifies only the email address */
  server.auth.scheme('auth0web', (scheme, opts) => ({
    async authenticate (request, reply) {
      try {
        var authorization = request.headers.authorization
        var token = authorization.match(/^Bearer (.*)$/)[1]

        assert(token)
        var result = jwt.verify(token, opts.secret)
        reply.continue({credentials: {
          email: result.email_verified && result.email,
          scope: result.email_verified ? ['email'] : [],
        }})
      } catch (err) {
        reply.continue({
          credentials: {email: null},
          scope: [],
        })
      }
    }
  }))
  server.auth.strategy('auth0web', 'auth0web', {secret: auth0Secret})

  function escapeLike (s) {
    return s.replace(/[\\%_]/g, m => `\\${m}`)
  }

  /**
    List all past suggestions
    **/
  server.route({
    method: "GET",
    path: "/suggestions/web",
    config: {
      tags: ['api'],
      auth: {
        mode: 'try',
        strategies: ['auth0web'],
        scope: 'email',
      },
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)

        var suggestions = await m.Suggestion.findAll({
          where: {
            email: {
              $ilike: escapeLike(request.auth.credentials.email)
            }
          },
          order: [['updatedAt', 'DESC']]
        })

        reply(suggestions.map(s => s.toJSON()))
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  server.route({
    method: "GET",
    path: "/suggestions/web/{id}",
    config: {
      tags: ['api'],
      auth: {
        mode: 'optional',
        strategies: ['auth0web'],
      },
      validate: {
        params: {
          id: Joi.number().integer(),
        }
      },
      description: `
      Returns a suggestion. If it belongs to the user, the email is returned in
      full. Otherwise it's returned partially anonymised
      `
    },
    handler: handleRequestWith(
      (i, request, {db, models}) => models.Suggestion.findById(request.params.id),
      (suggestionInstance, request) => {
        assertFound(suggestionInstance)
        const suggestion = suggestionInstance.toJSON()
        const credentialsEmail = _.get(request, 'auth.credentials.email')

        if (credentialsEmail && suggestion.email.toLowerCase() === credentialsEmail.toLowerCase()) {
          return suggestion
        } else {
          return {
            ...suggestion,
            email: anonymizeEmail(suggestion.email)
          }
        }
      }
    )
  })

  /**
    Edit existing suggestion
    **/
  server.route({
    method: "PUT",
    path: "/suggestions/web/{id}",
    config: {
      tags: ['api'],
      auth: {
        mode: 'required',
        strategies: ['auth0web'],
        scope: 'email',
      },
      validate: {
        params: {
          id: Joi.number().integer()
        },
        payload: {
          boardLat: Joi.number().optional().min(1).max(2),
          boardLon: Joi.number().optional().min(103).max(105),
          alightLat: Joi.number().optional().min(1).max(2),
          alightLon: Joi.number().optional().min(103).max(105),
          time: Joi.number().integer().required(),
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)

        var suggestion = await m.Suggestion.find({
          where: {
            id: request.params.id,
            email: {
              $ilike: escapeLike(request.auth.credentials.email)
            }
          }
        })
        NotFoundError.assert(suggestion)

        // Update the suggestion contents
        var update = {}

        // update board stop
        if (request.payload.boardLat && request.payload.boardLon) {
          update.board = {
            type: 'Point',
            coordinates: [request.payload.boardLon, request.payload.boardLon]
          }
        }

        // update alight stop
        if (request.payload.alightLat && request.payload.alightLon) {
          update.alight = {
            type: 'Point',
            coordinates: [request.payload.alightLon, request.payload.alightLon]
          }
        }

        // update time
        if (request.payload.time) {
          update.time = request.payload.time
        }

        await suggestion.update(update)

        updateTravelTime(suggestion).catch((err) => console.error(err))

        reply(suggestion.toJSON())
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  /**
    Edit existing suggestion
    **/
  server.route({
    method: "DELETE",
    path: "/suggestions/web/{id}",
    config: {
      tags: ['api'],
      auth: {
        mode: 'required',
        strategies: ['auth0web'],
        scope: 'email',
      },
      validate: {
        params: {
          id: Joi.number().integer()
        }
      }
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)

        var suggestion = await m.Suggestion.find({
          where: {
            id: request.params.id,
            email: {
              $ilike: escapeLike(request.auth.credentials.email)
            }
          }
        })
        NotFoundError.assert(suggestion)

        await suggestion.destroy()

        reply(suggestion.toJSON())
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    }
  })

  /**
    Creates a new suggestion
  **/
  server.route({
    method: "POST",
    path: "/suggestions/web",
    config: {
      tags: ["api"],
      auth: {
        mode: 'try',
        strategies: ['auth0web'],
      },
      description: 'For suggestions from the web, verified by email',
      validate: {
        payload: Joi.object({
          boardLat: Joi.number().required(),
          boardLon: Joi.number().required(),
          alightLat: Joi.number().required(),
          alightLon: Joi.number().required(),
          time: Joi.number().integer().required(),

          email: Joi.string().email(),
          emailVerification: Joi.object({
            type: Joi.string(),
            data: Joi.string()
          }).allow(null),
          currentMode: Joi.string().optional(),
          referrer: Joi.string().optional(),
        })
      },
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)

        var requestIP = request.headers['x-forwarded-for'] ||
          request.info.remoteAddress
        if (requestIP instanceof Array) {
          requestIP = requestIP[0]
          assert.strictEqual(typeof requestIP, 'string')
        }

        var suggestionData = {
          board: {
            type: "POINT",
            coordinates: [request.payload.boardLon, request.payload.boardLat]
          },
          alight: {
            type: "POINT",
            coordinates: [request.payload.alightLon, request.payload.alightLat]
          },
          time: request.payload.time,
          currentMode: request.payload.currentMode,
          email: request.payload.email,
          ipAddress: requestIP,
          referrer: request.payload.referrer
        }

        var emailTemplateText = Handlebars.compile(
          fs.readFileSync(path.join(__dirname, '/../../../data/suggestion-verification.txt'), 'utf-8')
        )
        var emailTemplateHtml = Handlebars.compile(
          fs.readFileSync(path.join(__dirname, '/../../../data/suggestion-verification.html'), 'utf-8')
        )

        if (!request.payload.emailVerification) {
          suggestionData.action = 'addSuggestion'
          var token = jwt.sign(suggestionData, auth.emailVerificationKey, {
            expiresIn: '30 days'
          })

          await email.sendMail({
            from: 'feedback@beeline.sg',
            to: request.payload.email,
            subject: 'Please verify your Beeline suggestion!',
            text: emailTemplateText({
              verificationLink: `https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token=${token}`,
            }),
            html: emailTemplateHtml({
              verificationLink: `https://${process.env.WEB_DOMAIN}/suggestions/web/verify?token=${token}`,
            }),
          })

          return reply(suggestionData)
        } else if (request.payload.emailVerification.type === 'auth0') {
          var creds = jwt.verify(request.payload.emailVerification.data, auth0Secret)

          assert(creds.email_verified, 'Your email must be verified with your provider (e.g. Google, Facebook)')
          assert.strictEqual(creds.email, request.payload.email, 'Verified email and email provided are not the same')

          var pastSuggestionsCount = await m.Suggestion.count({
            where: {
              email: {
                $ilike: escapeLike(request.payload.email)
              }
            },
            order: [['updatedAt', 'DESC']]
          })
          InvalidArgumentError.assert(pastSuggestionsCount < 5, "Each user is limited to 5 suggestions! Sorry!")

          // otherwise create the suggestion
          var suggestion = await m.Suggestion.create(suggestionData)

          updateTravelTime(suggestion).catch((err) => console.error(err))

          reply(suggestion.toJSON())
        } else {
          throw new InvalidArgumentError(`Unknown verification type ${request.payload.emailVerification.type}`)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })


  server.route({
    method: "GET",
    path: "/suggestions/web/verify",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        query: {
          token: Joi.string()
        }
      },
      description: `Endpoint used to validate suggestions from email`
    },
    async handler (request, reply) {
      try {
        var token = auth.verifyImmediate(request.query.token)
        var m = getModels(request)

        assert.strictEqual(token.action, 'addSuggestion', 'Invalid token')

        const suggestion = await m.Suggestion.create(token)

        updateTravelTime(suggestion).catch((err) => console.error(err))
        reply.redirect('https://beeline.sg/suggestSubmitted.html#' + querystring.stringify({
          originLat: token.board.coordinates[1],
          originLng: token.board.coordinates[0],
          destinationLat: token.alight.coordinates[1],
          destinationLng: token.alight.coordinates[0],
        }))
      } catch (err) {
        console.log(err.stack)
        return reply(Boom.badRequest(`
          The suggestion failed to be verified
          `))
          .header('content-type', 'text/html')
      }
    }
  })

  server.route({
    method: "GET",
    path: "/suggestions/web/similar",
    config: {
      tags: ["api"],
      validate: {
        query: {
          startLat: Joi.number().min(1).max(2),
          startLng: Joi.number().min(102).max(105),
          endLat: Joi.number().min(1).max(2),
          endLng: Joi.number().min(102).max(105),
          startDistance: Joi.number().default(5000).max(5000),
          endDistance: Joi.number().default(5000).max(5000),
        }
      },
      description: `Suggestions by all users`
    },
    async handler (request, reply) {
      try {
        var db = getDB(request)

        var startXY = toSVY([request.query.startLng, request.query.startLat])
        var endXY = toSVY([request.query.endLng, request.query.endLat])

        var sugg = await db.query(`
          SELECT DISTINCT ON (board, alight, time, email)
            *
          FROM suggestions
          WHERE
          (ST_distance(
            ST_Transform(ST_SetSRID(board, 4326), 3414),
            ST_GeomFromText('POINT(${startXY[0]} ${startXY[1]})', 3414)
          ) < ${request.query.startDistance} AND
          ST_distance(
            ST_Transform(ST_SetSRID(alight, 4326), 3414),
            ST_GeomFromText('POINT(${endXY[0]} ${endXY[1]})', 3414)
          ) < ${request.query.endDistance})
        `, {
          type: db.QueryTypes.SELECT
        })

        sugg = sugg.map(s => _.defaults({
          email: anonymizeEmail(s.email),
          ipAddress: null,
        }, s))
        reply(sugg)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}
register.attributes = {
  name: "endpoint-suggestions-web"
}

export function updateTravelTime (suggestion) {
  // FIXME We need actual knowledge of public holidays
  let imputedTime = new Date()
  imputedTime.setDate(imputedTime.getDate() + 1)
  imputedTime.setHours(0, 0, 0, 0)
  imputedTime.setTime(imputedTime.getTime() + suggestion.time) // Set to the arrival time tomorrow,

  while (imputedTime.getDay() === 0 || imputedTime.getDay() === 6) { // then increment until it's a working day
    imputedTime.setDate(imputedTime.getDate() + 1)
    // FIXME: Increment until it's a public holiday
  }

  return axios.get(`https://maps.googleapis.com/maps/api/directions/json?` + querystring.stringify({
    origin: `${suggestion.board.coordinates[1]},${suggestion.board.coordinates[0]}`,
    destination: `${suggestion.alight.coordinates[1]},${suggestion.alight.coordinates[0]}`,
    mode: 'transit',
    arrival_time: Math.floor(imputedTime / 1000),
    key: process.env.GOOGLE_MAPS_API_KEY
  }))
  .then((response) => {
    let result = response.data

    console.log(result)

    return suggestion.update({
      travelTime: _.sum(result.routes[0].legs.map(leg => leg.duration.value))
    })
  })
}
