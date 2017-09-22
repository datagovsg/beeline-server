const EventEmitter = require('events')
import eventDefinitions from './definitions'
import eventFormatters from './formatters'
import * as eventHandlers from './handlers'
import Joi from 'joi'
import assert from 'assert'
import _ from 'lodash'

export var defaultEmitter = new EventEmitter(eventDefinitions, eventFormatters).setMaxListeners(50)
var activeSubscriptions = []

// Handle the secondary events
defaultEmitter.on('newBooking', (data) => {
  var timeToTrip = data.trip.tripStops[0].time.getTime() - Date.now()

  defaultEmitter.emit('urgentBooking', _.assign({timeToTrip}, data))
})
defaultEmitter.on('error', (error) => {
  console.log(error.stack)
})

/** If ever this function is made asynchronous, remember to mutually
exclude multiple threads calling setSubscriptionList at the same time */
export function setSubscriptionList (list) {
  for (let [event, unbindFn] of activeSubscriptions) {
    unbindFn()
  }

  activeSubscriptions = []

  for (let {event, params, agent, formatter, handler} of list) {
    let listener = (data) => {
      try {
        let formattedMessage = eventFormatters[event][formatter](data)

        assert(typeof (formattedMessage.message) === 'string',
          `Formatter '${formatter}' for event '${event}' must return an object with a 'message' property`)

        eventHandlers[handler](agent, formattedMessage)
      } catch (err) {
        console.log(`Error handling message for agent #${agent && agent.id} ${err && err.message}`)
        console.log(err.stack)
      }
    }

    try {
      let unbindFn = on(event, params, listener)
      activeSubscriptions.push([event, unbindFn])
    } catch (err) {
      console.log(err.stack)
    }
  }
}

export function emit (event, data) {
  try { // handlers must not affect the execution of code
    var definition = eventDefinitions[event]

    assert(definition)
    Joi.assert(data, definition.schema)

    defaultEmitter.emit(event, data)
  } catch (err) {
    console.log(err.stack)
  }
}

/*
  on(event, [params], data)

  Overrides the on(event, callback) handler to accept
    a params option. The callback will only be called
    if the data passes the filters specified in params.

  Returns a method that, when called, removes the listener
*/
export function on () {
  assert(arguments.length === 2 || arguments.length === 3)
  var event, callback, params

  if (arguments.length === 2) {
    [event, callback] = arguments
  } else if (arguments.length === 3) {
    [event, params, callback] = arguments
  }

  var definition = eventDefinitions[event]

  assert(definition, `No such event type ${event}`)
  if (definition.params) {
    // Warn about any unused parameters
    let {error} = Joi.validate(params, definition.params)

    if (error) {
      console.error(`${event} Validation error ${JSON.stringify(error)}`)
    }

    // But when actually installing the handler, be more lenient
    let {value: validatedParamsUnk, error: errorUnk} = Joi.validate(
      params,
      definition.params.isJoi ? definition.params.unknown() : Joi.object(definition.params).unknown()
    )

    assert(!errorUnk, `${event} Validation error ${JSON.stringify(errorUnk)}`)

    params = validatedParamsUnk
  }

  var realCallback = definition.filter
    ? (data) => {
      if (definition.filter(params, data)) {
        callback(data)
      }
    } : callback

  defaultEmitter.on(event, realCallback)

  return () => defaultEmitter.removeListener(event, realCallback)
}
