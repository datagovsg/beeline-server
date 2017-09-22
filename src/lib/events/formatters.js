import os from 'os'
import {formatDate} from '../util/common'

export default {
  transactionFailure: {
    '0' (event) {
      return {
        message: `Transaction by user ${event.userId} failed with ${event.message}`,
      }
    }
  },

  newBooking: {
    '0' (event) {
      return {
        message: `A new booking has been made on ${event.trip.route.label} ` +
        `${event.trip.route.from} to ${event.trip.route.to} (${formatDate(event.trip.date)})`
      }
    }
  },

  lateArrival: {
    '0' (event) {
      return {
        message: `Bus arrived ${Math.floor(event.timeAfter / 60000)} mins late ${event.trip.route.label} ` +
        `${event.trip.route.from} to ${event.trip.route.to} (${formatDate(event.trip.date)})`
      }
    }
  },

  lateETA: {
    '0' (event) {
      return {
        message: `Bus may be ${Math.floor(event.timeAfter / 60000)} mins late ${event.trip.route.label} ` +
        `${event.trip.route.from} to ${event.trip.route.to} (${formatDate(event.trip.date)})`
      }
    }
  },

  urgentBooking: {
    '0' (event) {
      return {
        message: `A new booking has been made ${Math.floor(event.timeToTrip / 60000)} mins before ` +
          `the start of the trip ` +
          `${event.trip.route.label} ` +
          `${event.trip.route.from} to ${event.trip.route.to} ` +
          `(on ${formatDate(event.trip.date)})`,
      }
    }
  },

  tripCancelled: {
    '0' (event) {
      return {
        message: `Trip has been cancelled. ${event.trip.route.label} ` +
        `${event.trip.route.from} to ${event.trip.route.to} (on ${formatDate(event.trip.date)})`,
        severity: 6,
      }
    }
  },

  noPings: {
    '0' (event) {
      return {
        message: `Driver app was not switched on ` +
          `${Math.floor(event.minsBefore)} mins before start of ` +
          `${event.trip.route.label} ` +
          `${event.trip.route.from} to ${event.trip.route.to} (on ${formatDate(event.trip.date)})`,
        severity: (event.minsBefore <= 5) ? 5 : 4
      }
    }
  },

  passengersMessaged: {
    '0' (event) {
      return {
        message: `"${event.message}". Sent by ${event.sender} to ` +
          `${event.trip.route.label} ` +
          `${event.trip.route.from} to ${event.trip.route.to} (on ${formatDate(event.trip.date)})`,
        severity: 4,
      }
    }
  },

  internalServerError: {
    '0' (event) {
      return {
        severity: 4,
        message: `Internal server error: ${event.error.stack}`
      }
    }
  },

  lifecycle: {
    '0' (event) {
      return {
        message: `Server ${event.stage}ed on host ${os.hostname()}`
      }
    }
  }
}
