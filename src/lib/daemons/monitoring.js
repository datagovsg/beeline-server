// REQUIRED BY TELEGRAM
require('bluebird').config({cancellation: true})

const events = require('../events/events')

import assert from "assert"
import _ from "lodash"
import {toSVY} from '../util/svy21'
import {formatDate} from '../util/common'

const {db, models: m} = require('../core/dbschema')()
/* Since this is a separate process it needs to keep track of its own event subscriptions */
const eventSubTask = require('../daemons/eventSubscriptions.js')
const monitoringSms = require('./monitoringSms')
const { startPolling: schedule } = require('./scheduler')

const GEOFENCE_RADIUS = 120

// /////////////////
// Methods to communicate with the parent process
const methods = {
  getStatus () {
    return latestData
  },
  startPolling (ts) {
    const runThenPoll = options =>
      Promise.resolve(options.run()).then(() => schedule(options))
    runThenPoll({
      run: () => eventSubTask.updateEventSubscriptions({ models: m }),
      name: 'Reload event subscriptions from monitoring',
      interval: eventSubTask.updateInterval,
    })
    runThenPoll({
      run: pollPings,
      name: 'Poll pings from monitoring',
      interval: ts,
    })
  }
}

process.on('disconnect', () => {
  console.log('DISCONNECTED')
  process.exit()
})
process.on('message', async (m) => {
  try {
    var result = await methods[m.method].apply(undefined, m.args)

    process.send({
      id: m.id,
      result: result,
    })
  } catch (error) {
    process.send({
      id: m.id,
      exception: error,
    })
  }
})

function killProcesses () {
  console.log('SMS: KILLPROC')
  process.exit()
}
process.on('SIGTERM', killProcesses)
process.on('SIGINT', killProcesses)

// Compute the Euclidean distance
function eucDistance (a, b) {
  return Math.sqrt(
    (a[0] - b[0]) * (a[0] - b[0]) +
    (a[1] - b[1]) * (a[1] - b[1])
  )
}

// FIXME: Currently we look at pings by driver id.
//
export async function poll () {
  var now = new Date()
  var today = todayUTC()
  var hrs0000 = today0000()

  var trips = await m.Trip.findAll({
    where: {
      date: today
    },
    include: [
      {
        model: m.TripStop,
        include: [
          m.Stop,
          {
            separate: true,
            model: m.Ticket,
            where: {
              status: 'valid',
            },
            required: false,
          }
        ]
      },
      {
        model: m.Route,
        attributes: { exclude: ['path', 'features', 'notes'] },
      }
    ],
    order: [
      [m.TripStop, 'time', 'ASC']
    ]
  })
  var tripIds = trips.map(t => t.id)
  var pings = await m.Ping.findAll({
    where: {
      time: {
        $gte: hrs0000,
      },
      tripId: {$in: tripIds}
    },
    raw: true,
  })

  // ASSUMPTION: each day, each route only as one trip
  var tripsById = _.keyBy(trips, t => t.id)
  var statusByTripId = _.mapValues(tripsById, (trip) => {
    return {
      lastPing: undefined,
      status: null,

      trip: trip.toJSON(),
    }
  })

  // Precompute XY (must do this after toJSON())
  for (let status of _.values(statusByTripId)) {
    for (let tripStop of status.trip.tripStops) {
      tripStop._xy = toSVY(tripStop.stop.coordinates.coordinates)
    }
  }

  // compute the number of passengers
  for (let status of _.values(statusByTripId)) {
    status.trip.numPassengers = _.sumBy(status.trip.tripStops, ts => ts.tickets.length)
  }

  // Output here:
  // - Every stop has an arrival time / first ping / last ping
  // - The trip also has an arrival time / first ping / last ping
  _(pings)
    .groupBy('tripId')
    .forEach((pings, tripId) => {
      // Pre-compute the SVY values
      for (let ping of pings) {
        ping._xy = toSVY(ping.coordinates.coordinates)
      }

      let status = statusByTripId[tripId]

      for (let stop of status.trip.tripStops) {
        // Filter by distance
        let distances = pings.map(p => eucDistance(p._xy, stop._xy))
        let nearPings = pings.filter((p, i) => distances[i] <= GEOFENCE_RADIUS)

        stop.bestPing = _.minBy(nearPings, p => Math.abs(p.createdAt.getTime() - stop.time.getTime()))
        stop.bestPingDistance = stop.bestPing && eucDistance(stop.bestPing._xy, stop._xy)
      }

      status.lastPing = _.maxBy(pings, 'createdAt')
    })

  return {
    // Group by route id
    serviceData: _.keyBy(_.values(statusByTripId), s => s.trip.route.id),
    date: now,
  }
}

export class NotificationEvent {
  constructor (now, trip, severity, message) {
    assert(typeof trip === 'object')
    assert(typeof severity === 'number')
    assert(typeof message === 'string')

    this.now = now
    this.trip = trip
    this.severity = severity
    this.message = message
  }

  dedupKey () {
    var date = formatDate(this.now)
    return [
      date, this.trip.routeId, this.severity, this.message
    ].join('|')
    // return `${date}|${this.trip.routeId}|${this.severity}|${this.message}|`;
  }

  emit () {}

  async emitDeduped () {
    try {
      if (!this.message) return

      var [alertInstance, created] = await m.Alert.findCreateFind({
        where: {alertId: this.dedupKey()},
        defaults: {alertId: this.dedupKey()},
      })

      if (created) {
        this.emit()
      }
    } catch (err) {
      console.log(err)
    }
  }
}

export class NoPingsEvent extends NotificationEvent {
  constructor (now, trip, severity, delayInMins) {
    super(now, trip, severity, `Driver app not switched on ${delayInMins} mins before`)
    this.delayInMins = delayInMins
  }

  emit () {
    events.emit('noPings', {
      trip: this.trip,
      minsBefore: this.delayInMins
    })
  }

  /**
    Override the noPings emitDeduped.

    New functionality: If the last alert was more than ONE HOUR ago,
    and the trip is still running (determined by max of tripStops.time)
    then emit again.

   **/
  async emitDeduped () {
    try {
      if (!this.message) return

      var now = Date.now()

      var [alertInstance, created] = await m.Alert.findCreateFind({
        where: {alertId: this.dedupKey()},
        defaults: {alertId: this.dedupKey()},
      })

      if (created) {
        this.emit()
      } else if (alertInstance.updatedAt.getTime() < now - 60 * 60000) { // alert is a bit stale
        var lastTripTime = _.max(this.trip.tripStops.map(ts => ts.time))
        var tripIsStillRunning = lastTripTime && lastTripTime.getTime() > now

        // update my alert
        // FIXME: transaction handling? deduplication across instances?
        alertInstance.changed('updatedAt', true)
        alertInstance.save()

        if (tripIsStillRunning) {
          this.emit()
        }
      }
    } catch (err) {
      console.log(err)
    }
  }
}
export class LateArrivalEvent extends NotificationEvent {
  constructor (now, trip, severity, delayInMins) {
    super(now, trip, severity, `Service arrived ${delayInMins} mins late`)
    this.delayInMins = delayInMins
  }

  emit () {
    events.emit('lateArrival', {
      trip: this.trip,
      timeAfter: this.delayInMins * 60000
    })
  }
}
export class LateETAEvent extends NotificationEvent {
  constructor (now, trip, severity, delayInMins) {
    super(now, trip, severity, `Service might be more than ${delayInMins} mins late`)
    this.delayInMins = delayInMins
  }

  emit () {
    events.emit('lateETA', {
      trip: this.trip,
      timeAfter: this.delayInMins * 60000
    })
  }
}
export class CancellationEvent extends NotificationEvent {
  constructor (now, trip, severity) {
    super(now, trip, severity, `Emergency switched on`)
  }
}

const NonEvent = {
  /* OK means *green* status */
  OK (trip) { return new NotificationEvent(new Date(), trip, 0, '') },
  /* DontCare means grey status -- e.g. 12 hours before a trip starts, we frankly don't care */
  DontCare (trip) { return new NotificationEvent(new Date(), trip, -1, '') },
}

export function processStatus (pollData, sendMessages = true) {
  var svcs = pollData.serviceData
  var date = pollData.date
  var now = date.getTime()

  for (let rsid of Object.keys(svcs)) {
    let svc = svcs[rsid]

    // What are the relevant stops?
    // Depends on the notify-when-empty tag
    // Ignore alighting stops for regular routes because we don't want
    // to trigger if they arrive early etc.
    let routeTags = _.get(svc, 'trip.route.tags') || []
    let relevantStops = (routeTags.includes('notify-when-empty'))
      // Look at all boarding stops for lite routes, and assume all boarding stops have people
      ? svc.trip.tripStops.filter(s => s.canBoard)
      // Look at only boarding stops with people for regular routes
      : svc.trip.tripStops.filter(s =>
        s.canBoard && s.tickets && s.tickets.length !== 0)

    //
    let nextRelevantStop = relevantStops.find(s => s.time.getTime() > now)
    let nextStopRelevant = nextRelevantStop &&
      ((nextRelevantStop === relevantStops[0]) /* First stop -- if in the next 30 mins */
        ? nextRelevantStop.time.getTime() - now <= 30 * 60000
        : nextRelevantStop.time.getTime() - now <= 15 * 60000)
    let nextStopTime = nextRelevantStop && nextRelevantStop.time.getTime()

    // last relevant stops
    let prevRelevantStop = _.findLast(relevantStops, s => s.time.getTime() <= now)
    let prevStopRelevant = prevRelevantStop
    let prevStopTime = prevRelevantStop && prevRelevantStop.time.getTime()
    // If there is only one pickup stop, then it doesn't matter
    // if the bus leaves very early (e.g. 5mins) as long as everyone was on board.
    // But otherwise 2mins is the maximum because we don't want buses to have
    // to linger around at bus stops
    const arrivalWindow = relevantStops.length > 1
      ? -2 * 60000
      : -5 * 60000
    let isArrivedAtPrevStop = prevRelevantStop &&
      prevRelevantStop.bestPing &&
      (prevRelevantStop.bestPing.time.getTime() - prevRelevantStop.time.getTime() >= arrivalWindow)
    let deviationPrevStop = isArrivedAtPrevStop &&
      (prevRelevantStop.bestPing.time.getTime() - prevRelevantStop.time.getTime())

    // General trip status
    let recentlyPinged = svc.lastPing && (now - svc.lastPing.time.getTime() <= 5 * 60000) // In the last two minutes
    let isEmergency = svc.trip.status === 'cancelled'

    // Note: we are interested in the first stop with nonzero pickup
    let firstNz = svc.trip.tripStops.find(s => s.tickets && s.tickets.length !== 0)

    // Compute ETAs
    let speed = 35 // km/h
    const computeETA = function (c1, c2) {
      if (!c1 || !c2) return null
      var distance = eucDistance(c1, c2)
      return now + distance / 1000 / speed * 3600 * 1000
    }

    let prevStopETA = svc.lastPing && prevRelevantStop &&
      computeETA(svc.lastPing._xy, prevRelevantStop._xy)
    let nextStopETA = svc.lastPing && nextRelevantStop &&
      computeETA(svc.lastPing._xy, nextRelevantStop._xy)

    /* Emergency status does not affect ping or distance status directly,
      but we leave it as a notification */
    let emergencyEvent = isEmergency ? new CancellationEvent(now, svc.trip, 5) : NonEvent.DontCare(svc.trip)
    let pingEvent =
        nextStopRelevant
          ? (
            recentlyPinged ? NonEvent.OK(svc.trip)
              : (nextStopTime - now <= 5 * 60000) ? new NoPingsEvent(now, svc.trip, 4, 5)
                : (nextStopTime - now <= 25 * 60000) ? new NoPingsEvent(now, svc.trip, 3, numFiveMins(nextStopTime - now) * 5)
                  : NonEvent.DontCare(svc.trip)
          )
          : prevStopRelevant
            ? (/* Previous stop relevant */
              isArrivedAtPrevStop ? new NotificationEvent(now, svc.trip, 0, 'Bus has arrived')
                : recentlyPinged ? new NotificationEvent(now, svc.trip, 0, 'App is switched on')
                  : new NoPingsEvent(now, svc.trip, 4, 5)
            )
            : NonEvent.DontCare(svc.trip)

    let distanceEvent =
        nextStopRelevant
          ? (
            nextStopETA ? (
              nextStopETA - nextStopTime >= 10 * 60000
                ? new LateETAEvent(now, svc.trip, 3, 10)
                : new NotificationEvent(now, svc.trip, 0, 'Service is on track to arrive punctually')
            )
            /* No distance ==> can't give estimate. Let the absence of pings trigger the event*/
            : NonEvent.DontCare(svc.trip)
          )
          : prevStopRelevant
            ? (
              isArrivedAtPrevStop
                ? (
                  deviationPrevStop > 15 * 60000 ? new LateArrivalEvent(now, svc.trip, 3, (deviationPrevStop / 60000).toFixed(0))
                    : deviationPrevStop > 5 * 60000 ? new LateArrivalEvent(now, svc.trip, 2, (deviationPrevStop / 60000).toFixed(0))
                      : new NotificationEvent(now, svc.trip, 0, 'Service arrived on time')
                )
                : prevStopETA
                  ? (
                    (prevStopETA - prevStopTime >= 10 * 60000) ? new LateETAEvent(now, svc.trip, 3, 10)
                      : new NotificationEvent(now, svc.trip, 0, 'Service is on track to arrive punctually')
                  )
                  : NonEvent.DontCare(svc.trip)
            )
            : NonEvent.DontCare(svc.trip)

    // process the ping time...
    svc.status = {
      /* text + boolean status */
      arrivalTime: isArrivedAtPrevStop && prevRelevantStop.bestPing.time,
      emergency: isEmergency,
      eta: nextStopRelevant
        ? (nextStopETA && new Date(nextStopETA))
        : prevStopRelevant ? (prevStopETA && new Date(prevStopETA)) : null,
      bestPing: nextStopRelevant
        ? nextRelevantStop.bestPing
        : prevStopRelevant ? prevRelevantStop.bestPing : null,

      ping: pingEvent.severity,
      distance: distanceEvent.severity,
    }
    svc.nobody = !firstNz

    // Send notifications to operator
    if (sendMessages) {
      var mostSevereEvent = _.maxBy([emergencyEvent, distanceEvent, pingEvent], e => e ? e.severity : 0)

      if (mostSevereEvent) {
        monitoringSms.processNotifications([db, m], {
          event: mostSevereEvent,
          now: now,
          isNobodyAffected: svc.nobody
        })
        // IF AUTOCANCELLING CANCEL HERE
      }

      if (pingEvent) pingEvent.emitDeduped()
      if (distanceEvent) distanceEvent.emitDeduped()
      if (emergencyEvent) emergencyEvent.emitDeduped()
    }
  }
  return svcs
}

// / Helper methods
function todayUTC () {
  var now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}
function today0000 () {
  var now = new Date()
  now.setHours(0, 0, 0, 0)
  return now
}

function numFiveMins (ms) {
  return Math.ceil(ms / 60000 / 5)
}

// Entry point
var latestData

export async function pollPings () {
  var pollData = await exports.poll()
  latestData = exports.processStatus(pollData)
}
