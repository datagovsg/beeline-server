import Boom from "boom"
import Joi from "joi"
import assert from "assert"
import _ from "lodash"
import Sequelize from "sequelize"
const {db, models} = require('../core/dbschema')()
const sms = require("./sms")
const auth = require("../core/auth")

Date.prototype.toLocalString = function () {
  return new Date(this.getTime() - 60000 * this.getTimezoneOffset())
        .toISOString()
}

/**

['alert-id']

// send job to drivers (automatic)

alertId: 'send job for trip 456 to 99998832'

// send trip cancellation to customers (automatic)

alertId: 'send to customer trip 456 cancelled'

alertId: 'send to customer trip 456 ${statusId} late +15min'
alertId: 'send to customer trip 456 ${statusId} late +10min'
alertId: 'send to customer trip 456 ${statusId} late +5min'
**/

function NoDriverIdError (message) {
  // this.Error(message)
  this.constructor.apply(this, [message])
}
NoDriverIdError.prototype.constructor = Error


/** *
*  @param optionsRaw
*    @prop tripId
*/
export async function sendJobSMS (optionsRaw) {
  var {error, value: validatedOptions} = Joi.object({
    tripId: Joi.number().integer(),
  }).validate(optionsRaw)

  // Trip by TripId
  var trip = await models.Trip.findById(optionsRaw.tripId)
  assert(trip)
  var tripDate = trip.date.toISOString().substr(0, 10)
  var route = await models.Route.findById(trip.routeId)

  // assert driverId field is not empty
  if (!trip.driverId) {
    throw new NoDriverIdError("No Driver assingned yet")
  }

  // driver assigned to the trip
  var driver = await models.Driver.findById(trip.driverId)

  await db.transaction(async (t) => {
    try {
      var alertInstance = await models.Alert.create({
        alertId: `send job for trip ${optionsRaw.tripId} to ${driver.telephone}`
      }, {transaction: t})

      // new alert is inserted into db
      var tripToken = auth.signSession({
        tripId: trip.id,
        driverId: driver.id,
        role: "driver",
        transportCompanyId: route.transportCompanyId
      })
      var message = {
        from: "BeelinDrivr",
        to: driver.telephone,
        body:
  `Route from ${route.from} to ${route.to} for ${tripDate}. https://driver.beeline.sg/#/launch/${tripToken}`
      }

      var result = await sms.sendSMS(message)
    } catch (err) {
      if (err instanceof Sequelize.ValidationError) {
        console.log("Alert is sent out before")
      } else {
        throw err
      }
    }
  })
}

export async function sendTodayTrip () {
  var day = new Date().toLocalString().substr(0, 10)
  var allTodayTrips = await models.Trip.findAll({
    where: {
      date: day
    }
  })
  allTodayTrips.forEach(async (trip) => {
    try {
      // check 1st boarding stop time is within 2 hours from now
      var tripStops = await models.TripStop.findAll({
        where: {
          tripId: trip.id
        },
        order: [['time']],
        limit: 1,
      })
      var firstBoardStopTime = tripStops[0].time
      var now = new Date()

      var millisecondsToFirstStop = firstBoardStopTime.getTime() - now.getTime()
      if (millisecondsToFirstStop > 0 && millisecondsToFirstStop < 2 * 60 * 60 * 1000) {
        await sendJobSMS({
          tripId: trip.id
        })
      }
    } catch (err) {
      if (err instanceof NoDriverIdError) {
        console.log("please assign job to driver!!")
      } else {
        console.error(err.stack)
      }
    }
  })
}
