const {expect} = require("code")
import _ from "lodash"
import jwt from "jsonwebtoken"
import * as Payment from '../src/lib/transactions/payment'
const {models} = require("../src/lib/core/dbschema")()
const events = require('../src/lib/events/events')

export async function loginAs (type, options) {
  if (type === 'superadmin') {
    var tokenPayload = {
      email: `test-${Date.now()}@example.com`,
      email_verified: true,
      name: `Test Test`,
      app_metadata: {
        roles: ['superadmin'],
      }
    }
  } else if (type === 'admin') {
    var email = `test-admin-${Date.now()}@example.com`
    var adminInst = await models.Admin.create({
      email
    })
    if (options.transportCompanyId) {
      await adminInst.addTransportCompany(options.transportCompanyId, {
        permissions: options.permissions
      })
    }
    return {result: {sessionToken: adminInst.makeToken()}, statusCode: 200}
  } else if (type === 'user') {
    tokenPayload = {role: 'user'}
    if (typeof options === 'number') {
      _.extend(tokenPayload, {userId: options})
    } else {
      _.extend(tokenPayload, options)
    }
  } else if (type === 'driver') {
    var driverInst = await models.Driver.create({
      name: `TestDriver${Date.now()}`,
      telephone: `TestDriver${Date.now()}`,
    })
    tokenPayload = {
      role: 'driver',
      driverId: driverInst.id,
    }
    if (options.transportCompanyIds) {
      await driverInst.addCompanies(options.transportCompanyIds)
    }
    if (options.transportCompanyId) {
      await driverInst.addTransportCompany(options.transportCompanyId)
    }
  }

  /* Pretend to be an inject result */
  return Promise.resolve({
    result: {
      sessionToken: jwt.sign(tokenPayload, require("../src/lib/core/auth").secretKey)
    },
    statusCode: 200
  })
}

export function randomEmail () {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e8)}@example.com`
}

export function suggestionToken (email) {
  return jwt.sign(
    {email, email_verified: true},
    new Buffer(process.env.PUBLIC_AUTH0_SECRET, 'base64'))
}

/** Generates a random string n characters long **/
export function randomString (n = 10) {
  var s = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPRSTUVWXYZ'
  var t = ''

  for (let i = 0; i < n; i++) {
    t += s.charAt(Math.floor(Math.random() * s.length))
  }
  return t
}

export function randomSingaporeLngLat () {
  return [
    103.69 + Math.random() * 0.29,
    1.286 + Math.random() * 0.18
  ]
}

export function defaultErrorHandler (reply) {
  return (err) => {
    console.log(err.stack)
    reply(err)
  }
}

export async function createStripeToken (cardNo) {
  return await Payment.createStripeToken({
    number: cardNo || "4242424242424242",
    exp_month: "12",
    exp_year: "2019",
    cvc: "123"
  }).then(stripeToken => stripeToken.id)
}

export function expectEvent (eventName, params) {
  var rv = {
    isEmitted: false,
    async check () {
      // Delay a while, let the event be propagated
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(this.isEmitted).true()
      this.remove()
    },
    remove: null
  }
  rv.remove = events.on(eventName, params, () => {
    rv.isEmitted = true
  })
  return rv
}

export async function cleanlyDeleteUsers (where) {
  const userIds = (await models.User.findAll({where})).map(u => u.id)
  await models.Credit.destroy({
    where: {
      userId: {$in: userIds}
    }
  })
  await models.ReferralCredit.destroy({
    where: {
      userId: {$in: userIds}
    }
  })
  await models.Ticket.destroy({
    where: {
      userId: {$in: userIds}
    }
  })
  await models.Suggestion.destroy({
    where: {userId: {$in: userIds}}
  })
  await models.User.destroy({where})
}

export async function cleanlyDeletePromotions (where) {
  const promotionIds = (await models.Promotion.findAll({where})).map(u => u.id)
  await models.PromoUsage.destroy({
    where: {
      promoId: {$in: promotionIds}
    }
  })
  await models.Promotion.destroy({where})
}

export async function resetTripInstances (models, tripInstances) {
  const destroyTickets = trip =>
    trip.tripStops.map(stop => models.Ticket.destroy({
      where: { boardStopId: stop.id }
    }))

  const resetTrip = trip => Promise.all(destroyTickets(trip))
    .then(() => models.Trip.update(
      { seatsAvailable: trip.capacity },
      { where: { id: trip.id } }
    ))

  return Promise.all(tripInstances.map(resetTrip))
}
