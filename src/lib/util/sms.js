import _ from 'lodash'
import assert from 'assert'
import BlueBird from 'bluebird'

export var AccountSID = process.env.TWILIO_ACCOUNT_SID
export var AuthToken = process.env.TWILIO_AUTH_TOKEN
export var defaultFrom = "BeelineSG"

export var inTrial = false
export var client = require("twilio")(AccountSID, AuthToken)

import {RateLimitError} from './errors'

const rateLimit = {}

export var sendSMS = (what) => {
  // Ensure that SMS is sent at most once every 30 seconds to the same number
  assert(what.to)
  if (what.rateLimit && rateLimit[what.to]) throw new RateLimitError(`Too many SMS requests by ${what.to}`)
  setTimeout(() => delete rateLimit[what.to], 30000)
  rateLimit[what.to] = true

  if (inTrial || !what.from) {
    _.assign(what, {from: defaultFrom})
  }

  // Temporarily disable alphanumeric IDs until Twilio fixes their problem
  // what.from = defaultFrom;

  return BlueBird.promisify(client.messages.create, {context: client.messages})(what)
}
