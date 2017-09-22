import Joi from 'joi'
import _ from 'lodash'
import * as auth from '../core/auth'
import assert from 'assert'

const RouteNotificationParams = {
  transportCompanyIds: Joi.array().items(Joi.number().integer()),
  routeIds: Joi.array().items(Joi.number().integer()),
  ignoreIfEmpty: Joi.boolean().default(true),
}

/**
  The trip schema and test function when we are concerned whether or not
  there are passengers
**/
const TripSchemaPax = Joi.object({
  route: Joi.any().required(),
  routeId: Joi.number().integer().allow(null).required(),
  numPassengers: Joi.number().integer(),
}).unknown()

function testTripRoutePax (params, event) {
  return (!params.routeIds || params.routeIds.indexOf(event.trip.routeId) !== -1) &&
    (!params.transportCompanyIds || params.transportCompanyIds.indexOf(event.trip.route.transportCompanyId) !== -1) &&
    (event.trip.numPassengers || !params.ignoreIfEmpty ||
        (event.trip.route.tags && event.trip.route.tags.indexOf('notify-when-empty') !== -1))
}

/**
  The trip schema and test function
**/
const TripSchema = Joi.object({
  route: Joi.any().required(),
  routeId: Joi.number().integer().allow(null).required(),
}).unknown()

function testTripRoute (params, event) {
  return (!params.routeIds || params.routeIds.indexOf(event.trip.routeId) !== -1) &&
    (!params.transportCompanyIds || params.transportCompanyIds.indexOf(event.trip.route.transportCompanyId) !== -1)
}


export default {
  transactionFailure: {
    schema: {
      userId: Joi.alternatives().try(Joi.number(), Joi.string()),
      message: Joi.string()
    },
    authorize: authorizeBySuperadmin
  },

  newBooking: {
    params: _.defaults({}, RouteNotificationParams),

    schema: Joi.object({
      ticket: Joi.object({
        boardStop: Joi.any().required(),
        alightStop: Joi.any().required(),
      }).unknown().required(),
      trip: TripSchema,
    }).unknown(),

    filter (params, event) {
      return testTripRoute(params, event)
    },
    authorize: authorizeByCompanyId
  },

  newPurchase: {
    schema: Joi.object({
      userId: Joi.number().required(),
      promotionId: Joi.number().allow(null),
      numValidPromoTickets: Joi.number().allow(null),
    }),
    authorize: authorizeByCompanyId
  },

  urgentBooking: {
    params: _.defaults({
      maxTimeToTrip: Joi.number().required().description('In milliseconds')
    }, RouteNotificationParams),

    schema: Joi.object({
      ticket: Joi.object({
        boardStop: Joi.any().required(),
        alightStop: Joi.any().required(),
      }).unknown().required(),
      trip: TripSchema,
      timeToTrip: Joi.number()
    }).unknown(),

    filter (params, event) {
      return event.timeToTrip < params.maxTimeToTrip &&
        testTripRoute(params, event)
    },
    authorize: authorizeByCompanyId
  },

  tripCancelled: {
    params: _.defaults({}, RouteNotificationParams),

    schema: Joi.object({
      trip: TripSchema
    }),

    filter (params, event) {
      return testTripRoute(params, event)
    },
    authorize: authorizeByCompanyId
  },

  internalServerError: {
    schema: Joi.object({
      error: Joi.object({}).unknown().required()
    }).unknown(),

    authorize: authorizeBySuperadmin
  },

  noPings: {
    params: _.defaults({
      minsBefore: Joi.array().items(Joi.any().valid([5, 10, 15, 20, 25])),
    }, RouteNotificationParams),

    schema: Joi.object({
      trip: TripSchemaPax,
      minsBefore: Joi.number().integer().description("Number of minutes before the start of the trip [5,10,15,20,25]")
        .valid([5, 10, 15, 20, 25])
        .required(),
    }).unknown(),

    filter (params, event) {
      return testTripRoutePax(params, event) &&
        (params.minsBefore.indexOf(event.minsBefore) !== -1)
    },

    authorize: authorizeByCompanyId
  },

  lateArrival: {
    params: _.defaults({
      timeAfter: Joi.number().integer().required(),
    }, RouteNotificationParams),

    schema: Joi.object({
      trip: TripSchemaPax,
      timeAfter: Joi.number().integer().description("Number of milliseconds after the start of the trip"),
    }).unknown(),

    filter (params, event) {
      return testTripRoutePax(params, event) &&
        (typeof (params.timeAfter) !== 'number' || params.timeAfter <= event.timeAfter)
    },
    authorize: authorizeByCompanyId
  },

  lateETA: {
    params: _.defaults({
      timeAfter: Joi.number().integer().required(),
    }, RouteNotificationParams),

    schema: Joi.object({
      trip: TripSchemaPax,
      timeAfter: Joi.number().integer().description("Number of milliseconds before the start of the trip"),
    }).unknown(),

    filter (params, event) {
      return testTripRoutePax(params, event) &&
        (typeof (params.timeAfter) !== 'number' || params.timeAfter <= event.timeAfter)
    },

    authorize: authorizeByCompanyId
  },

  passengersMessaged: {
    params: _.defaults({}, RouteNotificationParams),

    schema: Joi.object({
      message: Joi.string().required(),
      sender: Joi.string().required(),
      trip: TripSchemaPax,
    }).unknown(),

    filter (params, event) {
      return testTripRoutePax(params, event)
    },

    authorize: authorizeByCompanyId
  },

  lifecycle: {
    schema: {
      stage: Joi.string()
    },

    authorize (credentials) {
      return credentials.scope === 'superadmin'
    }
  },

  crowdstart: {
    schema: {
      label: Joi.string().allow(null)
    },

    authorize (credentials) {
      return credentials.scope === 'superadmin'
    }
  },
}

function authorizeByCompanyId (credentials, companyId, params) {
  params.transportCompanyIds = [companyId]
}
function authorizeBySuperadmin (credentials) {
  assert(credentials.scope === 'superadmin', 'Only superadmins can receive notifications on this event')
}
