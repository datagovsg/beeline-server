const Joi = require('joi')
const Boom = require('boom')
const common = require('../util/common')

export function register (server, options, next) {
  server.route({
    method: 'GET',
    path: '/tickets',
    config: {
      tags: ['api'],
      description: 'Update a route (for admin and superadmin only)',
      auth: {access: {scope: ['user']}},
      validate: {
        query: Joi.object({
          startTime: Joi.date().default(() => common.midnightToday(), '0000hrs today'),
          transportCompanyId: Joi.number().integer().optional()
        }).unknown()
      }
    },

    handler: async function (request, reply) {
      var m = common.getModels(request)

      var ticketQuery = {
        where: {
          userId: request.auth.credentials.userId,
          status: 'valid'
        },
        include: [
          {
            model: m.TripStop,
            as: 'boardStop',
            include: [m.Stop,
              {
                model: m.Trip,
                include: [{
                  model: m.Route,
                  where: {},
                }],
              }
            ],
            where: {
              time: {
                $gt: request.query.startTime
              }
            },
            required: true
          },
          {
            model: m.TripStop,
            as: 'alightStop',
            include: [m.Stop, m.Trip],
            required: false
          }
        ],
        order: [
          [{model: m.TripStop, as: 'boardStop'}, 'time', 'ASC']
        ]
      }

      if (request.query.transportCompanyId) {
        ticketQuery.include[0].include[1].include[0].where.transportCompanyId = request.query.transportCompanyId
      }

      try {
        reply((await m.Ticket.findAll(ticketQuery).map(tick => tick.toJSON())))
      } catch (err) {
        reply(Boom.badImplementation(err))
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/tickets/{id}',
    config: {
      tags: ['api'],
      auth: {access: {scope: ['user']}},
      validate: {
        params: {
          id: Joi.number()
        }
      }
    },
    handler: async function (request, reply) {
      var m = common.getModels(request)

      try {
        reply((await m.Ticket.findOne({
          where: {
            id: request.params.id,
            userId: request.auth.credentials.userId,
            status: 'valid'
          },
          include: [
            {
              model: m.TripStop,
              as: 'boardStop',
              include: [m.Stop, m.Trip]
            },
            {
              model: m.TripStop,
              as: 'alightStop',
              include: [m.Stop, m.Trip]
            }
          ]
        })).toJSON())
      } catch (err) {
        reply(Boom.badImplementation(err))
      }
    }
  })

  next()
}

register.attributes = {
  name: 'endpoint-tickets'
}
