const Joi = require('joi')
const Boom = require('boom')
const common = require('../util/common')
const { InvalidArgumentError } = require('../util/errors')
const { handleRequestWith, instToJSONOrNotFound, assertFound, assertThat, authorizeByRole } = require('../util/endpoints')

export function register (server, options, next) {
  const addTripCodeToTicket = (ticket) => {
    if (ticket) {
      const tripCode = ticket.boardStop.trip.getCode(true)
      ticket.setDataValue('tripCode', tripCode)
    }
    return ticket
  }

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
        const tickets = await m.Ticket.findAll(ticketQuery)

        reply(
          tickets
            .map(addTripCodeToTicket)
            .map(tick => tick.toJSON())
        )
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
    handler: handleRequestWith(
      (ignored, request, {models}) => models.Ticket.findOne({
        where: {
          id: request.params.id,
          userId: request.auth.credentials.userId,
          status: 'valid'
        },
        include: [
          {
            model: models.TripStop,
            as: 'boardStop',
            include: [models.Stop, models.Trip]
          },
          {
            model: models.TripStop,
            as: 'alightStop',
            include: [models.Stop, models.Trip]
          }
        ]
      }),
      addTripCodeToTicket,
      instToJSONOrNotFound
    ),
  })

  server.route({
    method: 'PUT',
    path: '/tickets/{id}/status',
    config: {
      tags: ['api'],
      auth: {access: {scope: ['admin', 'superadmin']}},
      description: `Update the state of a ticket.
        Currently limited to changing its status between void and valid for now`,
      validate: {
        params: {
          id: Joi.number()
        },
        payload: {
          status: Joi.string().valid(['void', 'valid']).required()
        },
      }
    },
    handler: handleRequestWith(
      (ignored, request, { models }) => models.Ticket.findById(request.params.id, {
        include: [{
          model: models.TripStop,
          as: 'alightStop',
          attributes: ['tripId'],
          include: [{
            model: models.Trip,
            attributes: ['routeId'],
            include: [{ model: models.Route, attributes: ['transportCompanyId'] }]
          }]
        }]
      }),
      assertFound,
      authorizeByRole('issue-tickets', ticket => ticket.alightStop.trip.route.transportCompanyId),
      assertThat(
        ticket => ['void', 'valid'].includes(ticket.status),
        InvalidArgumentError, 'Ticket status has to be valid or void'
      ),
      (ticket, request) => ticket.update({ status: request.payload.status })
    ),
  })

  next()
}

register.attributes = {
  name: 'endpoint-tickets'
}
