const boom = require("boom")
const request = require("request")
const leftPad = require('left-pad')
const assert = require('assert')
const jwt = require('jsonwebtoken')
const {SecurityError, NotFoundError, RateLimitError, InvalidArgumentError,
        TransactionError, ChargeError} = require('./errors')

export {SecurityError, NotFoundError, RateLimitError, InvalidArgumentError,
        TransactionError, ChargeError}

export function defaultErrorHandler (cb) {
  return (err) => {
    console.error(err.stack)

    if (err instanceof SecurityError) {
      return cb(boom.forbidden(err.message))
    } else if (err instanceof RateLimitError) {
      return cb(boom.tooManyRequests(err.message))
    } else if (err instanceof NotFoundError) {
      return cb(boom.notFound(err.message))
    } else if (err instanceof NotFoundError) {
      return cb(boom.notFound(err.message))
    } else if (err instanceof InvalidArgumentError) {
      return cb(boom.badRequest(err.message))
    } else if (err instanceof ChargeError) {
      return cb(boom.create(402, err.message, err.message))
    } else if (err instanceof assert.AssertionError) {
      return cb(boom.badImplementation(err.message))
    } else if (err instanceof TransactionError) {
      const response = boom.badRequest(err.message)
      response.output.payload.source = err.data ? err.data.source : null
      return cb(response)
    } else if (err instanceof jwt.JsonWebTokenError) {
      return cb(boom.forbidden(err.message))
    }

    cb(boom.badImplementation(err))
  }
}

export function criticalErrorHandler (cb) {
  return (err) => {
    if (process.env.SLACK_WEBHOOK_URL) {
      request({
        method: 'POST',
        url: process.env.SLACK_WEBHOOK_URL,
        headers: {
          "Content-type": "application/json"
        },
        body: JSON.stringify({
          text: err.stack,
          color: 'danger'
        })
      })
    }
    cb(boom.badRequest(err))
  }
}

export function getDB (request) {
  return request.server.plugins["sequelize"].db
}
export function getModels (request) {
  return request.server.plugins["sequelize"].models
}

export function midnightToday () {
  var d = new Date()
    // local time
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
export function midnightTomorrow () {
  var d = new Date()
    // local time
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
}

export function getDeviceUUID (request) {
  // check that is is a valid uuid
  var trackingId = null
  var uuid = request.headers["beeline-device-uuid"]

  if (!uuid) return null

  uuid = uuid.replace(/-/g, "")
  uuid = uuid.toLowerCase()

  if (!/^[a-f0-9]{32}$/.test(uuid)) {
    return null
  } else {
    uuid = uuid.substr(0, 8) + "-" +
          uuid.substr(8, 4) + "-" +
          uuid.substr(12, 4) + "-" +
          uuid.substr(16, 4) + "-" +
          uuid.substr(20, 12)
    return uuid
  }
}


export function roundToNearestCent (value) {
  return Math.round(value * 100) / 100
}

export function assertFound (object, message) {
  if (!object) throw new NotFoundError(message)
}

var months = 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec'.split(',')
var dayOfWeek = 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')

export function formatDate (date) {
  if (!date) return ''
  if (typeof (date) === 'string') {
    date = new Date(date)
  }
  if (typeof (date) === 'number') {
    date = new Date(date)
  }
  assert(date instanceof Date)

  return date.getDate() + ' ' + months[date.getMonth()] + ' ' + date.getFullYear()
}
export function formatDateUTC (date) {
  if (!date) return ''
  if (typeof (date) === 'string') {
    date = new Date(date)
  }
  if (typeof (date) === 'number') {
    date = new Date(date)
  }
  assert(date instanceof Date)

  return date.getUTCDate() + ' ' + months[date.getUTCMonth()] + ' ' + date.getUTCFullYear()
}

export function formatDateLong (date) {
  if (!date) return ''

  if (typeof (date) === 'string') {
    date = new Date(date)
  }
  if (typeof (time) === 'number') {
    date = new Date(date)
  }

  return date.getDate() + ' ' + months[date.getMonth()] + ' ' + date.getFullYear() +
    ', ' + dayOfWeek[date.getDay()]
}

export function formatTime24 (time) {
  if (typeof (time) === 'string') {
    time = new Date(time)
  }
  if (typeof (time) === 'number') {
    time = new Date(time)
  }
  return leftPad(time.getHours(), 2, '0') + ':' + leftPad(time.getMinutes(), 2, '0')
}

export function formatTime12 (time) {
  if (typeof (time) === 'string') {
    time = new Date(time)
  }
  if (typeof (time) === 'number') {
    time = new Date(time)
  }
  var hours = time.getHours()
  var minutes = time.getMinutes()

  var hours12 = (hours % 12) || 12

  return leftPad(hours12, 2, '\u2007') + ':' + leftPad(minutes, 2, '0') +
    ' ' + (hours < 12 ? 'AM' : 'PM')
}

export function assertUTCMidnight (date) {
  try {
    assert(date instanceof Date, `${date} is not a Date`)

    var errorMessage = `Date ${date.toISOString()} is not in UTC midnight`
    assert.strictEqual(date.getUTCHours(), 0, errorMessage)
    assert.strictEqual(date.getUTCMinutes(), 0, errorMessage)
    assert.strictEqual(date.getUTCSeconds(), 0, errorMessage)
    assert.strictEqual(date.getUTCMilliseconds(), 0, errorMessage)
  } catch (e) {
    throw new InvalidArgumentError(e.message)
  }
}
