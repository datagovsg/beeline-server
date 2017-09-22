const Joi = require("joi")
const auth = require('../core/auth')
const common = require("../util/common")
const Boom = require("boom")
const stream = require('stream')
import Sequelize from "sequelize"
import {getModels, getDB, defaultErrorHandler, assertFound} from '../util/common'

/**
Returns a Sequelize WHERE clause suited
for determining whether the user credentials
is authorized to make changes to
the suggestion **/
function authenticateAgent (id, request) {
  var creds = request.auth ? request.auth.credentials : null
  var uuid = common.getDeviceUUID(request)
  var query

  if (!creds || creds.scope === "public") {
    if (uuid) {
      /* Authorization access to suggestions by the
      same anonymous dude */
      query = {
        where: {
          userId: null,
          email: uuid + "@anonymous.beeline.sg"
        }
      }
    } else {
      /* Authorize nothing */
      return {
        where: {
          $and: [false]
        }
      }
    }
  } else {
    query = {
      where: {
        $or: [
          request.auth.credentials.scope === "superadmin",
          request.auth.credentials.scope === "admin",
          {
            $and: [
              request.auth.credentials.scope === "user",
              { userId: request.auth.credentials.userId }
            ]
          }
        ]
      }
    }
  }
  // if specific id was requested...
  if (id != null && id !== undefined) { query.where.id = id }

  return query
}

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/companies/{companyId}/suggestions",
    config: {
      auth: {access: {scope: ['admin']}},
      tags: ["api"],
      description: `Retrieve all the suggestions owned by a particular company`
    },
    async handler (request, reply) {
      try {
        const db = getDB(request)
        const m = getModels(request)

        auth.assertAdminRole(request.auth.credentials, 'manage-customers', request.params.companyId)

        // Company referrer
        const companyReferrer = (await m.TransportCompany.findById(request.params.companyId)).referrer

        const io = new stream.PassThrough()
        reply(io)

        if (!companyReferrer) {
          io.write('[]')
          io.end()
        } else {
          io.write('[\n')
          db.transaction(async (t) => {
            let offset = 0
            const limit = 1000
            var numWritten = 0

            while (true) {
              const q = {
                order: [['id', 'ASC']],
                transaction: t,
                offset, limit
              }

              const suggestions = await m.Suggestion.findAll(q) // eslint-disable-line no-await-in-loop
              const ownedByCompany = suggestions.filter(s => s.referrer === companyReferrer)

              if (ownedByCompany.length) {
                for (let i = 0; i < ownedByCompany.length; i++) {
                  if (numWritten > 0) {
                    io.write(',\n')
                  }

                  const writeResult = io.write(JSON.stringify(ownedByCompany[i].toJSON()))
                  numWritten++

                  if (!writeResult) {
                    await new Promise((resolve) => io.once('drain', resolve)) // eslint-disable-line no-await-in-loop
                  }
                }
              }

              if (suggestions.length < limit) {
                io.write('\n]')
                io.end()
                break
              } else {
                offset += limit
              }
            }
          }).catch((err) => {
            io.write("Oops!")
            io.end()
            console.log(err)
          })
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/suggestions",
    config: {
      auth: {access: {scope: ['user', 'public']}},
      tags: ["api"],
    },
    handler: async function (request, reply) {
      try {
        var m = common.getModels(request)

        var suggestions = await m.Suggestion.findAll(authenticateAgent(null, request))

        reply(suggestions.map(sugg => sugg.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      description: "Get a specific suggestion",
      validate: {
        params: {
          id: Joi.number().integer()
        }
      }
    },
    handler: async function (request, reply) {
      try {
        var m = common.getModels(request)

        var suggestion = await m.Suggestion.findOne(authenticateAgent(request.params.id, request))

        assertFound(suggestion)

        reply(suggestion && suggestion.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  /**
    Creates a new suggestion
  **/
  server.route({
    method: "POST",
    path: "/suggestions",
    config: {
      tags: ["api"],
      validate: {
        payload: Joi.object({
          userId: Joi.number().integer().optional(),

          boardLat: Joi.number().required(),
          boardLon: Joi.number().required(),
          alightLat: Joi.number().required(),
          alightLon: Joi.number().required(),
          time: Joi.number().integer().required(),

          currentMode: Joi.string().optional(),
          referrer: Joi.string().optional(),
        })
      },
      description:
`Creates a new suggestion. Anonymous suggestions are allowed, provided a
device-UUID is provided.`
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)
        var userId = null
        var trackingId = null
        var uuid = common.getDeviceUUID(request)

        if (request.auth.credentials.scope === "user") {
          userId = request.auth.credentials.userId
        } else if (uuid) {
          trackingId = uuid + "@anonymous.beeline.sg"
        } else {
          return reply(Boom.forbidden())
        }

        // FIXME: check for existing similar suggestions and prevent
        // them from being added

        // otherwise create the suggestion
        var suggestion = await m.Suggestion.create(
          {
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
            userId: userId,

            email: trackingId,
            ipAddress: null, // FIXME: remember you need to handle reverse proxies correctly
            referrer: request.payload.referrer
          }
        )
        reply(suggestion.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  /* Update the suggestion name */
  server.route({
    method: "PUT",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      validate: {
        payload: Joi.object({
          id: Joi.number().integer().optional(),
          userId: Joi.number().integer().optional(),

          boardLat: Joi.number().required().min(1).max(2),
          boardLon: Joi.number().required().min(100).max(110),
          alightLat: Joi.number().required().min(1).max(2),
          alightLon: Joi.number().required().min(100).max(110),
          time: Joi.number().integer().required().min(0).max(60 * 60 * 24),

          currentMode: Joi.string().optional()
        })
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)

        // FIXME: check for existing similar suggestions

        // otherwise create the suggestion
        await m.Suggestion.update(
          {
            board: {
              type: "POINT",
              coordinates: [request.payload.boardLon, request.payload.boardLat]
            },
            alight: {
              type: "POINT",
              coordinates: [request.payload.alightLon, request.payload.alightLat]
            },
            time: request.payload.time,
            currentMode: request.payload.currentMode
          },
          authenticateAgent(request.params.id, request)
        )
        reply(m.Suggestion.findById(request.params.id))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  /* Delete */
  server.route({
    method: "DELETE",
    path: "/suggestions/{id}",
    config: {
      tags: ["api"],
      validate: {
        params: {
          id: Joi.number().integer().required()
        }
      }
    },
    handler: async function (request, reply) {
      try {
        var m = getModels(request)

        var result = await m.Suggestion.destroy(authenticateAgent(request.params.id, request))
        if (result[0] === 0) {
          return reply(Boom.notFound())
        } else {
          reply("")
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "POST",
    path: "/suggestions/deanonymize",
    config: {
      tags: ["api"],
      description:
`Converts all anonymous suggestions made under a particular device uuid
to suggestions under a user`
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var uuid = common.getDeviceUUID(request)

        if (!uuid) {
          return reply(Boom.badRequest())
        }
        var trackingId = uuid + "@anonymous.beeline.sg"
        var userId = request.auth.credentials.userId

        if (!userId) {
          return reply(Boom.forbidden())
        }

        var [numRowsAffected] = await m.Suggestion.update({
          userId: userId
        }, {
          where: {
            userId: null,
            email: trackingId
          }
        })
        reply(numRowsAffected)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  /* Find Similar */
  server.route({
    method: "GET",
    path: "/suggestions/{id}/similar",
    config: {
      tags: ["api"],
      validate: {
        query: Joi.object({
          distance: Joi.number().default(500).max(2000).min(100),
          minTime: Joi.number().default(0),
          maxTime: Joi.number().default(60 * 60 * 24)
        }).unknown(),
        params: {
          id: Joi.number().integer().required()
        }
      },
      description: `
Finds all suggestions (including this one) similar to the given
suggestion, in terms of straight-line distance and time.

Results meet the following criteria:

<pre>minTime &lt;= time &lt;= maxTime

distance(boardingPointA, boardingPointB) &lt;= distance

distance(alightingPointA, alightingPointB) &lt;= distance </pre>

`
    },
    handler: async function (request, reply) {
      try {
        var db = getDB(request)

        var similarSuggestions = await db.query(`
SELECT
    s2.board,
    s2.alight,
    ST_Transform(ST_SetSRID(s1.board, 4326), 3414) <->
            ST_Transform(ST_SetSRID(s2.board, 4326), 3414) AS boardDistance,
    ST_Transform(ST_SetSRID(s1.alight, 4326), 3414) <->
            ST_Transform(ST_SetSRID(s2.alight, 4326), 3414) AS alightDistance,
    s2.time,
    s2."createdAt",
    s2."updatedAt"
FROM suggestions AS s1
    INNER JOIN suggestions AS s2
        ON ST_Transform(ST_SetSRID(s1.board, 4326), 3414) <->
                ST_Transform(ST_SetSRID(s2.board, 4326), 3414) <= :maxDistance

        AND ST_Transform(ST_SetSRID(s1.alight, 4326), 3414) <->
                ST_Transform(ST_SetSRID(s2.alight, 4326), 3414) <= :maxDistance

WHERE
    s1.id = :referenceId

    AND s2.time >= :minTime
    AND s2.time <= :maxTime

                `,
          {
            type: Sequelize.QueryTypes.SELECT,
            replacements: {
              referenceId: request.params.id,
              maxDistance: request.query.distance,
              minTime: request.query.minTime,
              maxTime: request.query.maxTime
            }
          }
        )

        reply(similarSuggestions)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })
  next()
}
register.attributes = {
  name: "endpoint-suggestions"
}
