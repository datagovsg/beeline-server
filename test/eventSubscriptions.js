const {models: m} = require('../src/lib/core/dbschema')()
const {loginAs, randomSingaporeLngLat, randomEmail} = require("./test_common")
import {expect} from "code"
import server from "../src/index"
import Lab from "lab"
import Joi from 'joi'
import eventDefinitions from '../src/lib/events/definitions'
import eventFormatters from '../src/lib/events/formatters'
import * as eventHandlers from '../src/lib/events/handlers'
import * as events from '../src/lib/events/events'

export const lab = Lab.script()

lab.experiment("Event subscriptions", function () {
  let adminInst
  let companyInst
  let lastMessage

  lab.before({timeout: 10000}, async function () {
    eventDefinitions['testEvent'] = {
      schema: Joi.object({
        num: Joi.number().required(),
      }).unknown(),
    }

    eventDefinitions['testEventWithParams'] = {
      schema: Joi.object({
        num: Joi.number().required(),
      }).unknown(),

      params: Joi.object({
        string: Joi.string().required(),
      }),

      filter (params, data) {
        return parseInt(params.string) === data.num
      },
    }

    eventFormatters['testEvent'] = {
      '0' (event) {
        return {message: `First is ${event.num}`}
      },
      '1' (event) {
        return {message: `Second is ${event.num}`}
      },
    }
    eventFormatters['testEventWithParams'] = {
      '0' (event) {
        return {
          message: `First is ${event.num}`,
        }
      },
      '1' (event) {
        return {
          message: `Second is ${event.num}`,
        }
      },
    }
    adminInst = await m.Admin.create({
      email: 'test@example.com',
      telephone: '+6581001860',
    })
    companyInst = await m.TransportCompany.create({})

    await adminInst.addTransportCompany(companyInst, {permissions: ['manage-notifications', 'update-trip-status']})

    eventHandlers['test'] = (agent, payload) => {
      expect(agent.email).equal(adminInst.email)
      expect(agent.telephone).equal(adminInst.telephone)
      lastMessage = payload.message
    }

    while (!server.plugins['daemon-event-subscriptions']) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })

  lab.beforeEach(async function () {
    lastMessage = null
  })

  lab.afterEach(async function () {
    await m.EventSubscription.destroy({
      where: {
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
      },
    })
  })

  lab.test('Subscriptions are properly validated', async function () {
    let createResult = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      payload: {
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
        event: 'testEventWithParams',
        formatter: '0',
        params: {invalidParams: true},
        handler: 'test',
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
    })
    /* 500 because we don't have a reference to Joi.ValidationError and
    so we cannot trap it :( */
    expect(createResult.statusCode).equal(500)

    createResult = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      payload: {
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
        event: 'testEventWithParams',
        formatter: '0',
        params: {string: '123'},
        handler: 'test',
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
    })
    expect(createResult.statusCode).equal(200)
  })

  lab.test('Subscriptions are properly loaded', {timeout: 10000}, async function () {
    let createResult = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      payload: {
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
        event: 'testEvent',
        formatter: '0',
        params: null,
        handler: 'test',
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
    })
    let subscriptionId = createResult.result.id

    // the reload is not synchronous, so let it wait...
    await new Promise((resolve) => setTimeout(resolve, 500))
    events.emit('testEvent', {num: 12})
    expect(lastMessage).equal('First is 12')

    lastMessage = null

    // PUT
    createResult = await server.inject({
      method: 'PUT',
      url: `/companies/${companyInst.id}/eventSubscriptions/${subscriptionId}`,
      payload: {
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
        event: 'testEvent',
        formatter: '1',
        params: null,
        handler: 'test',
      },
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
    })

    // the reload is not synchronous, so let it wait...
    await new Promise((resolve) => setTimeout(resolve, 500))
    events.emit('testEvent', {num: 12})
    expect(lastMessage).equal('Second is 12')

    lastMessage = null

    // DELETE
    createResult = await server.inject({
      method: 'DELETE',
      url: `/companies/${companyInst.id}/eventSubscriptions/${subscriptionId}`,
      headers: {
        authorization: `Bearer ${adminInst.makeToken()}`,
      },
    })

    // the reload is not synchronous, so let it wait...
    await new Promise((resolve) => setTimeout(resolve, 500))
    events.emit('testEvent', {num: 12})
    expect(lastMessage).equal(null)
  })


  lab.test('A different formatter has effect', {timeout: 10000}, async function () {
    await m.EventSubscription.create({
      agent: {
        telephone: adminInst.telephone,
        email: adminInst.email,
      },
      event: 'testEvent',
      formatter: '1',
      params: null,
      handler: 'test',
    })

    await server.plugins['daemon-event-subscriptions'].reloadSubscriptions()

    events.emit('testEvent', {num: 12})

    expect(lastMessage).equal('Second is 12')
  })

  lab.test('Subscriptions with parameters', {timeout: 10000}, async function () {
    await m.EventSubscription.create({
      agent: {
        telephone: adminInst.telephone,
        email: adminInst.email,
      },
      event: 'testEventWithParams',
      formatter: '0',
      params: {string: '12'},
      handler: 'test',
    })

    await server.plugins['daemon-event-subscriptions'].reloadSubscriptions()

    events.emit('testEventWithParams', {num: 12})
    expect(lastMessage).equal('First is 12')

    // It should fail the filter requirement, so test handler is not called
    events.emit('testEventWithParams', {num: 11})
    expect(lastMessage).equal('First is 12')
  })

  lab.test('Transaction failure event', {timeout: 10000}, async function () {
    let userInst = await m.User.create({})
    await m.EventSubscription.create({
      agent: {
        telephone: adminInst.telephone,
        email: adminInst.email,
      },
      event: 'transactionFailure',
      formatter: '0',
      params: {string: '12'},
      handler: 'test',
    })
    await server.plugins['daemon-event-subscriptions'].reloadSubscriptions()

    // Make a transaction that will fail
    await server.inject({
      method: 'POST',
      url: '/transactions/tickets/payment',
      payload: {
        trips: [
          {tripId: 1999,
            boardStopId: 22,
            alightStopId: 22},
        ],
        stripeToken: 'fake token',
      },
      headers: {
        authorization: `Bearer ${userInst.makeToken()}`,
      },
    })

    // Failure should be in message
    expect(lastMessage.indexOf('fail')).above(0)
    expect(lastMessage.indexOf(userInst.id.toString())).above(0)
  })

  lab.test('Trip cancellation event', {timeout: 10000}, async function () {
    // Some trip data
    let a = await m.Admin.create({
      email: 'test@asdfasdfasdfexample.com',
      telephone: '+6599999999',
    })
    let c = await m.TransportCompany.create({
      name: 'Required for some reason',
    })

    await a.addTransportCompany(c, {permissions: ['manage-notifications', 'update-trip-status']})

    let routeInst = await m.Route.create({
      transportCompanyId: c.id,
    })
    let stopInst = await m.Stop.create({
      coordinates: {type: 'Point', coordinates: randomSingaporeLngLat()},
    })
    let tripInst = await m.Trip.create({
      routeId: routeInst.id,
      tripStops: [
        {stopId: stopInst.id, time: '2016-01-01T00:00:00', canBoard: true, canAlight: true},
        {stopId: stopInst.id, time: '2016-01-01T04:00:00', canBoard: true, canAlight: true},
      ],
    }, {include: [m.TripStop]})
    const headers = {
      authorization: `Bearer ${a.makeToken()}`,
    }
      // Some event data
    await m.EventSubscription.create({
      agent: {
        telephone: adminInst.telephone,
        email: adminInst.email,
      },
      event: 'tripCancelled',
      formatter: '0',
      params: {routeIds: [routeInst.id], ignoreIfEmpty: false},
      handler: 'test',
    })
    await server.plugins['daemon-event-subscriptions'].reloadSubscriptions()
    // Execute the cancellation
    await server.inject({
      method: 'POST',
      url: `/trips/${tripInst.id}/messages`,
      payload: {
        status: 'cancelled',
      },
      headers,
    })

    // Failure should be in message
    expect(lastMessage.indexOf('cancelled')).above(0)
  })

  lab.test('Validation of unknown fields', {timeout: 10000}, async function () {
    // Some trip data
    let companyInst = await m.TransportCompany.create({})
    let routeInst = await m.Route.create({
      transportCompanyId: companyInst.id,
    })
    let stopInst = await m.Stop.create({
      coordinates: {type: 'Point', coordinates: randomSingaporeLngLat()},
    })
    let tripInst = await m.Trip.create({
      routeId: routeInst.id,
      tripStops: [
        {stopId: stopInst.id, time: '2016-01-01T00:00:00', canBoard: true, canAlight: true},
        {stopId: stopInst.id, time: '2016-01-01T04:00:00', canBoard: true, canAlight: true},
      ],
    }, {include: [m.TripStop]})

    // Some event data
    await m.EventSubscription.create({
      agent: {
        telephone: adminInst.telephone,
        email: adminInst.email,
      },
      event: 'tripCancelled',
      formatter: '0',
      params: {routeIds: [routeInst.id], unknownField: 'blah', ignoreIfEmpty: false},
      handler: 'test',
    })
    let login = await loginAs('superadmin')
    await server.plugins['daemon-event-subscriptions'].reloadSubscriptions()

    // Execute the cancellation
    await server.inject({
      method: 'POST',
      url: `/trips/${tripInst.id}/messages`,
      payload: {
        status: 'cancelled',
      },
      headers: {
        authorization: `Bearer ${login.result.sessionToken}`,
      },
    })

    // Failure should be in message
    expect(lastMessage.indexOf('cancelled')).above(0)
  })

  lab.test('Authorization of some endpoints', async function () {
    let subscription = {}

    eventDefinitions.newBooking.authorize({}, 10, subscription)
    expect(subscription.transportCompanyIds[0]).equal(10)

    eventDefinitions.urgentBooking.authorize({}, 20, subscription)
    expect(subscription.transportCompanyIds[0]).equal(20)
  })

  lab.test('CRUD subscriptions', async function () {
    // Some trip data
    let companyInst = await m.TransportCompany.create({})
    await m.Route.create({
      transportCompanyId: companyInst.id,
    })
    await m.Stop.create({
      coordinates: {type: 'Point', coordinates: randomSingaporeLngLat()},
    })
    let adminInst = await m.Admin.create({
      email: randomEmail(),
    })
    await adminInst.addTransportCompany(companyInst, {permissions: ['manage-notifications', 'update-trip-status']})

    let headers = {
      authorization: `Bearer ${adminInst.makeToken()}`,
    }
    let response

    // Create subscription
    response = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      payload: {
        event: 'testEventWithParams',
        params: { string: '1' },
        formatter: '0',
        handler: 'test',
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
      },
      headers,
    })
    expect(response.statusCode).equal(200)

    let subscriptionObject = await m.EventSubscription.findById(response.result.id)
    expect(subscriptionObject).exist()

    // check that authorization has worked, and the set of companies is restricted
    // Create subscription
    response = await server.inject({
      method: 'POST',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      payload: {
        event: 'newBooking',
        params: { },
        formatter: '0',
        handler: 'test',
        agent: {
          telephone: adminInst.telephone,
          email: adminInst.email,
        },
      },
      headers,
    })
    expect(response.statusCode).equal(200)

    subscriptionObject = await m.EventSubscription.findById(response.result.id)
    expect(subscriptionObject.params.transportCompanyIds[0]).equal(companyInst.id)

    let createdSubscriptionId = response.result.id

    // Read
    response = await server.inject({
      method: 'GET',
      url: `/companies/${companyInst.id}/eventSubscriptions`,
      headers,
    })
    expect(response.statusCode).equal(200)
    expect(response.result.find(t => t.id === createdSubscriptionId)).exist()

    // Update
    response = await server.inject({
      method: 'PUT',
      url: `/companies/${companyInst.id}/eventSubscriptions/${createdSubscriptionId}`,
      payload: {
        event: 'testEvent',
        params: { string: '2' },
        formatter: '0',
        handler: 'test',
      },
      headers,
    })
    expect(response.statusCode).equal(200)
    let subscrInst = await m.EventSubscription.findById(createdSubscriptionId)
    expect(subscrInst.event).equal('testEvent')
    expect(subscrInst.params.string).equal('2')

    // DELETE
    response = await server.inject({
      method: 'DELETE',
      url: `/companies/${companyInst.id}/eventSubscriptions/${createdSubscriptionId}`,
      headers,
    })
    expect(response.statusCode).equal(200)
    subscrInst = await m.EventSubscription.findById(createdSubscriptionId)
    expect(subscrInst).not.exist()
  })
})

lab.experiment("Event handlers", function () {
  let mocked = {
    sendSMS ({to, from, body}) {
      expect(typeof to).equal('string')
      expect(typeof from).equal('string')
      expect(from.length).most(11)
      expect(typeof body).equal('string')
    },
    sendMail ({to, from, subject, text}) {
      expect(to.indexOf('@')).above(0)
      expect(from.indexOf('@')).above(0)
      expect(typeof subject).equal('string')
      expect(typeof text).equal('string')
    },
    sendTelegram (chatId, message) {
      expect(typeof message).equal('string')
      expect(/^[0-9]+$/.test(chatId)).equal(true)
    },
  }

  let real = {
    sendSMS: null,
    sendEmail: null,
    sendTelegram: null,
  }

  lab.before(async () => {
    real = {
      sendSMS: require('../src/lib/util/sms').sendSMS,
      sendMail: require('../src/lib/util/email').sendMail,
      sendTelegram: require('../src/lib/util/telegram').sendTelegram,
    }

    require('../src/lib/util/sms').sendSMS = mocked.sendSMS
    require('../src/lib/util/email').sendMail = mocked.sendMail
    require('../src/lib/util/telegram').sendTelegram = mocked.sendTelegram
  })

  lab.after(async () => {
    require('../src/lib/util/sms').sendSMS = real.sendSMS
    require('../src/lib/util/email').sendMail = real.sendMail
    require('../src/lib/util/telegram').sendTelegram = real.sendTelegram
  })

  lab.test('Event handlers succeed', async () => {
    let payload = {
      message: 'Hello world!',
      severity: 3,
    }
    eventHandlers.sms(
      {telephone: "+6588881111"},
      payload
    )

    eventHandlers.telegram(
      {notes: {telegramChatId: '12345'}},
      payload
    )

    eventHandlers.email(
      {email: 'test@example.com'},
      payload
    )
  })
})
