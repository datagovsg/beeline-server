const Lab = require("lab")
const lab = exports.lab = Lab.script()
const {expect, fail} = require('code')

const server = require("../src/index.js")
const {db, models: m} = require("../src/lib/core/dbschema")()
import {loginAs, randomSingaporeLngLat, expectEvent} from './test_common'
import querystring from 'querystring'
import sinon from 'sinon'
import * as sms from '../src/lib/util/sms'
import * as onesignal from '../src/lib/util/onesignal'
import _ from 'lodash'

lab.experiment("Trip manipulation", function () {
  let authHeaders
  let company, route
  let sandbox

  lab.before({timeout: 10000}, async () => {
    company = await m.TransportCompany.create({
      name: "XYZ Company",
    })

    route = await m.Route.create({
      description: "Some route",
      transportCompanyId: company.id,
    })

    let response = await loginAs(
      "admin",
      {
        transportCompanyId: company.id,
        permissions: ['manage-routes'],
      }
    )

    expect(response.statusCode).to.equal(200)
    authHeaders = {
      authorization: "Bearer " + response.result.sessionToken,
    }
  })

  /**
    * Set up and teardown the Sinon sandbox
    */
  lab.beforeEach(async function () {
    sandbox = sinon.sandbox.create()
  })

  lab.afterEach(async function () {
    sandbox.restore()
  })

  const createStopsTripsUsersTickets = async function (companyId) {
    let stopInstances = await Promise.all(
      _.range(0, 2).map((i) => m.Stop.create({
        description: `Test Stop ${i}`,
        coordinates: {
          type: "Point",
          coordinates: randomSingaporeLngLat(),
        },
      }))
    )

    let routeInst = await m.Route.create({
      description: "Some route",
      transportCompanyId: companyId,
    })

    const year = new Date().getFullYear() + 1

    let tripInst = await m.Trip.create({
      date: `${year}-03-01`,
      capacity: 10,
      routeId: routeInst.id,
      price: (Math.random() * 3 + 3).toFixed(2),
      tripStops: [
        { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: `${year}-03-01T08:30:00+0800`},
        { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: `${year}-03-01T08:31:00+0800`},
      ],
      bookingInfo: {
        windowType: 'stop',
        windowSize: 0,
      },
    }, {
      include: [m.TripStop],
    })

    // add passengers here
    let userInst = await m.User.create({
      name: 'XXXXXX',
      telephone: `+0000${Date.now()}`,
    })
    let ticketInst = await m.Ticket.create({
      boardStopId: tripInst.tripStops[0].id,
      alightStopId: tripInst.tripStops[1].id,
      userId: userInst.id,
      status: 'valid',
    })

    return {stopInstances, tripInst, userInst, ticketInst, routeInst}
  }

  lab.test("Dates in postgres are coerced to UTC timezone", async function () {
    let result = await db.query(`SELECT '2016-01-01'::date AS a`, {type: db.QueryTypes.SELECT})
    expect(result[0].a.valueOf()).equal(new Date('2016-01-01T00:00:00Z').valueOf())
  })

  lab.test("Get trips", function () {
    return server.inject({
      method: "GET",
      url: "/trips",
      headers: authHeaders,
    }).then((resp) => {
      expect(resp.statusCode).to.equal(200)
    })
  })

  lab.test("Add trip", async function () {
    let stops = await Promise.all([
      m.Stop.create({ coordinates: {type: "Point", coordinates: [103.41, 1.38]}, description: "Some stop 1"}),
      m.Stop.create({ coordinates: {type: "Point", coordinates: [103.42, 1.38]}, description: "Some stop 2"}),
      m.Stop.create({ coordinates: {type: "Point", coordinates: [103.42, 1.39]}, description: "Some stop 3"}),
      m.Stop.create({ coordinates: {type: "Point", coordinates: [103.50, 1.40]}, description: "Some stop 4"}),
    ])

    let trip = {
      capacity: 10,
      status: "ACTIVE",
      driverId: null,
      vehicleId: null,
      routeId: route.id,
      price: '3.45',
      date: new Date('2016-02-01').getTime(),

      tripStops: [
        { stopId: stops[0].id, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
        { stopId: stops[1].id, canBoard: true, canAlight: false, time: "2016-02-01T08:06:00+0800"},
        { stopId: stops[2].id, canBoard: true, canAlight: false, time: "2016-02-01T08:03:00+0800"},
        { stopId: stops[3].id, canBoard: false, canAlight: true, time: "2016-02-01T08:09:00+0800"},
      ],
      bookingInfo: {
        windowType: 'stop',
        windowSize: 10000,
        childTicketPrice: '1.00',
      },
    }

    let options = {
      method: "POST",
      url: "/trips",
      payload: trip,
      headers: authHeaders,
    }

    let compareResponses = function (a, b) {
      // check object equality...
      expect(a.capacity).to.equal(b.capacity)
      // expect(a.transportCompanyId).to.equal(b.transportCompanyId)
      expect(a.driverId).to.equal(b.driverId)
      expect(a.vehicleId).to.equal(b.vehicleId)
      expect(a.price).to.equal(b.price)
      expect(a.status).to.equal(b.status)
      expect(a.tripStops.length).to.equal(b.tripStops.length)
      expect(new Date(a.date).getTime()).to.equal(b.date)

      expect(a.seatsAvailable).to.equal(b.capacity)

      for (let i = 0; i < 4; i++) {
        expect(a.tripStops.filter((ts) => {
          return ts.stopId === b.tripStops[i].stopId
        }).length).to.equal(1)
      }
    }

    let postResponse = await server.inject(options)

    expect(postResponse.statusCode).to.equal(200)
    // check object equality...
    expect(postResponse.result).to.include("id")
    compareResponses(postResponse.result, trip)

    let getResponse = await server.inject({
      method: "GET",
      url: "/trips/" + postResponse.result.id,
      headers: authHeaders,
    })

    // ensure that with the GET, the stops are returned in sorted order
    for (let i = 0; i < getResponse.result.tripStops.length - 1; i++) {
      let thisStop = getResponse.result.tripStops[i]
      let nextStop = getResponse.result.tripStops[i + 1]

      expect(new Date(thisStop.time).getTime())
        .to.be.lessThan(new Date(nextStop.time).getTime())
    }

    expect(getResponse.statusCode).to.equal(200)
    // check object equality...
    expect(getResponse.result).to.include("id")
    compareResponses(getResponse.result, trip)

    // Check trip PUT
    let putResponse = await server.inject({
      method: 'PUT',
      url: `/trips/${getResponse.result.id}`,
      headers: authHeaders,
      payload: _.omit(_.defaults({
        bookingInfo: {
          childTicketPrice: '2.00',
          windowType: 'firstStop',
          windowSize: 30000,
        },
        tripStops: getResponse.result.tripStops,
      }, trip), ['routeId', 'date']),
    })
    expect(putResponse.result.bookingInfo.childTicketPrice).equal(2)
    expect(putResponse.result.bookingInfo.windowType).equal('firstStop')
    expect(putResponse.result.bookingInfo.windowSize).equal(30000)

    let deleteResponse = await server.inject({
      method: "DELETE",
      url: "/trips/" + getResponse.result.id,
      headers: authHeaders,
    })

    expect(deleteResponse.statusCode).to.equal(200)
  })

  const testCapacityChange = options => async function () {
    const {tripInst} = await createStopsTripsUsersTickets(company.id)

    const initialCapacity = tripInst.capacity
    const initialSeatsAvailable = options.initialSeatsAvailable
    const capacityChange = options.capacityChange

    await m.Trip.update(
      { seatsAvailable: initialSeatsAvailable },
      { where: { id: tripInst.id } }
    )

    let payload = _.omit(
      _.defaults(
        { capacity: initialCapacity + capacityChange },
        tripInst.get({ plain: true })
      ),
      [
        'routeId', 'date', 'availability', 'priceF', 'isRunning', 'messages',
        'id', 'createdAt', 'updatedAt', 'seatsAvailable', 'transportCompanyId',
      ]
    )
    let putResponse = await server.inject({
      method: 'PUT',
      url: `/trips/${tripInst.id}`,
      headers: authHeaders,
      payload: payload,
    })
    expect(putResponse.statusCode).equal(options.statusCode)
    if (options.statusCode === 200) {
      expect(putResponse.result.capacity).equal(initialCapacity + capacityChange)
      expect(putResponse.result.seatsAvailable).equal(options.expectedSeatsAvailable)

      const trip = await m.Trip.findById(tripInst.id)

      expect(trip.capacity).equal(initialCapacity + capacityChange)
      expect(trip.seatsAvailable).equal(options.expectedSeatsAvailable)
    }
  }

  lab.test(
    'Capacity increase should increase seatsAvailable',
    testCapacityChange({
      initialSeatsAvailable: 8, capacityChange: 5,
      statusCode: 200, expectedSeatsAvailable: 13,
    })
  )

  lab.test(
    'Capacity decrease < seatsAvailable -> seatsAvailable > 0',
    testCapacityChange({
      initialSeatsAvailable: 8, capacityChange: -3,
      statusCode: 200, expectedSeatsAvailable: 5,
    })
  )

  lab.test(
    'Capacity decrease > seatsAvailable -> Error',
    testCapacityChange({
      initialSeatsAvailable: 1, capacityChange: -2,
      statusCode: 400, expectedSeatsAvailable: 0,
    })
  )

  lab.test(
    'Cannot change trip date unless there are no bookings',
    async function (done) {
      const {tripInst, ticketInst} =
        await createStopsTripsUsersTickets(company.id)

      // Check that changing the date would fail
      const newDate = Date.UTC(2018, 1, 1, 0, 0, 0)
      const diff = newDate - tripInst.date.getTime()

      const payloadWithDate = {
        date: new Date(newDate),
        capacity: tripInst.capacity,
        tripStops: (await tripInst.getTripStops({raw: true}))
          .map(ts => ({
            ...ts,
            time: new Date(ts.time.getTime() + diff),
          })),
      }

      const putResponse = await server.inject({
        method: 'PUT',
        url: `/trips/${tripInst.id}`,
        headers: authHeaders,
        payload: payloadWithDate,
      })

      expect(putResponse.statusCode).equal(400)

      await ticketInst.destroy()

      const putResponse2 = await server.inject({
        method: 'PUT',
        url: `/trips/${tripInst.id}`,
        headers: authHeaders,
        payload: payloadWithDate,
      })

      expect(putResponse2.statusCode).equal(200)
    }
  )

  lab.test('Message passengers', async function () {
    const {tripInst} = await createStopsTripsUsersTickets(company.id)

    const sendSMSStub = sandbox.stub(sms, 'sendSMS', async function (options) {})

    // Try sending as admin...
    const adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['message-passengers'],
    })
    const ev = expectEvent('passengersMessaged', {routeIds: [tripInst.routeId]})
    const adminSendResponse = await server.inject({
      method: 'POST',
      url: `/trips/${tripInst.id}/messagePassengers`,
      headers: {
        Authorization: `Bearer ${adminCreds.result.sessionToken}`,
      },
      payload: {
        message: 'This is a test run',
      },
    })
    expect(sendSMSStub.called).true()
    expect(adminSendResponse.statusCode).equal(200)
    await ev.check()

    // Try sending as superadmin...
    sendSMSStub.reset()
    const superadminCreds = await loginAs('superadmin')
    const superadminSendResponse = await server.inject({
      method: 'POST',
      url: `/trips/${tripInst.id}/messagePassengers`,
      headers: {
        Authorization: `Bearer ${superadminCreds.result.sessionToken}`,
      },
      payload: {
        message: 'This is a test run',
      },
    })
    expect(sendSMSStub.called).true()
    expect(superadminSendResponse.statusCode).equal(200)
  })

  lab.test('Messages should be from BeelineSG by default', async function () {
    const {tripInst} = await createStopsTripsUsersTickets(company.id)

    const sendSMSStub = sandbox.stub(sms, 'sendSMS', async function (options) {
      expect(options.message.from).equal('BeelineSG')
    })

    await tripInst.messagePassengers('This is a test run')
    expect(sendSMSStub.called).true()
  })

  lab.test('Messages should be from operator code if available', async function () {
    const smsOpCode = 'XYZCO'
    let smsCompany = await m.TransportCompany.create({
      name: "XYZ Company",
      smsOpCode: smsOpCode,
    })
    const {tripInst} = await createStopsTripsUsersTickets(smsCompany.id)

    const sendSMSStub = sandbox.stub(sms, 'sendSMS', async function (options) {
      expect(options.message.from).equal(smsOpCode)
    })

    await tripInst.messagePassengers('This is a test run')
    expect(sendSMSStub.called).true()
  })

  lab.test('Messages should be sent to OneSignal', async function () {
    const smsOpCode = 'XYZCO'
    let smsCompany = await m.TransportCompany.create({
      name: "XYZ Company",
      smsOpCode: smsOpCode,
    })

    const {tripInst, userInst} = await createStopsTripsUsersTickets(smsCompany.id)

    const message = 'This is a test run'

    userInst.notes = {
      ...userInst.notes,
      pushNotificationTag: '1234-5678-9012-3456',
    }
    await userInst.save()

    /* Stub the SMS so that no real SMS is sent */
    sandbox.stub(sms, 'sendSMS', async function () {})

    /* Stub OneSignal */
    const sendNotificationStub = sandbox.stub(onesignal, 'createNotification', async function (url, body) {
      expect(body.contents.en).equal(message)
      expect(body.filters.find(f =>
        f.field === 'tag' &&
        f.key === 'user_tag' &&
        f.relation === '=' &&
        f.value === userInst.notes.pushNotificationTag
      )).exist()
    })

    await tripInst.messagePassengers(message)
    expect(sendNotificationStub.called).true()
  })

  lab.test('Querying ticket report by date enforces UTC midnight', async function () {
    const {ticketInst} = await createStopsTripsUsersTickets(company.id)

    await m.Transaction.create({
      committed: true,
      transactionItems: [
        {itemType: 'ticketSale', itemId: ticketInst.id, credit: 0},
      ],
    }, {
      include: [m.TransactionItem],
    })

    let adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['view-transactions'],
    })
    let headers = {
      authorization: `Bearer ${adminCreds.result.sessionToken}`,
    }

    const year = new Date().getFullYear() + 1

    // Get the ticket reports
    // Dates OK
    let defaultQuery = {
      perPage: 100,
      page: 1,
      orderBy: 'createdAt',
      order: 'desc',
      tripStartDate: new Date(`${year}-03-01`).getTime(),
      tripEndDate: new Date(`${year}-03-02`).getTime(),
      statuses: JSON.stringify(['valid']),
    }
    let ticketReport = await server.inject({
      method: 'GET',
      url: '/custom/wrs/report?' + querystring.stringify(defaultQuery),
      headers,
    })
    expect(ticketReport.statusCode).equal(200)
    expect(ticketReport.result.rows[0].id).equal(ticketInst.id)

    // Dates not OK
    ticketReport = await server.inject({
      method: 'GET',
      url: '/custom/wrs/report?' + querystring.stringify(
        _.defaults({
          tripStartDate: new Date('2018-03-01T00:00:00+0800').getTime(),
        }, defaultQuery)),
      headers,
    })
    expect(ticketReport.statusCode).equal(400)
  })

  lab.test('Querying by ticket id works', async function () {
    const {ticketInst} = await createStopsTripsUsersTickets(company.id)

    await m.Transaction.create({
      committed: true,
      transactionItems: [
        {itemType: 'ticketSale', itemId: ticketInst.id, credit: 0},
      ],
    }, {
      include: [m.TransactionItem],
    })

    let adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['view-transactions'],
    })
    let headers = {
      authorization: `Bearer ${adminCreds.result.sessionToken}`,
    }

    // Get the ticket reports
    // Dates OK
    let defaultQuery = {
      ticketId: ticketInst.id,
    }
    let ticketReport = await server.inject({
      method: 'GET',
      url: '/custom/wrs/report?' + querystring.stringify(defaultQuery),
      headers,
    })
    expect(ticketReport.statusCode).equal(200)
    expect(ticketReport.result.rows.length).equal(1)
    expect(ticketReport.result.rows[0].id).equal(ticketInst.id)
  })

  lab.test('ticketSales show route pass txn description', async function () {
    const {ticketInst, routeInst, userInst} = await createStopsTripsUsersTickets(company.id)
    const tag = `rp-${Date.now()}`

    await routeInst.update({ tags: [tag] })

    const adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['view-transactions', 'issue-tickets'],
    })

    const headers = {
      authorization: `Bearer ${adminCreds.result.sessionToken}`,
    }

    const response = await server.inject({
      method: "POST",
      url: "/transactions/route_passes/issue_free",
      payload: {
        description: 'Issue 1 Free Pass',
        userId: userInst.id,
        routeId: routeInst.id,
        tag,
      },
      headers,
    })

    let transactionItemsByType = _.groupBy(response.result.transactionItems, ti => ti.itemType)
    expect(transactionItemsByType.routePass).exist()
    expect(transactionItemsByType.routePass.length).equal(1)
    const routePassItemId = transactionItemsByType.routePass[0].itemId

    // Simulate a sale
    await m.Transaction.create({
      committed: true,
      transactionItems: [
        {itemType: 'ticketSale', itemId: ticketInst.id, credit: 5},
        {itemType: 'routePass', itemId: routePassItemId, debit: 5},
      ],
    }, {
      include: [m.TransactionItem],
    })

    let defaultQuery = {
      ticketId: ticketInst.id,
    }
    let ticketReport = await server.inject({
      method: 'GET',
      url: '/custom/wrs/report?' + querystring.stringify(defaultQuery),
      headers,
    })
    expect(ticketReport.statusCode).equal(200)
    expect(ticketReport.result.rows.length).equal(1)
    expect(ticketReport.result.rows[0].id).equal(ticketInst.id)
    expect(ticketReport.result.rows[0].routePass).exist()
  })

  lab.test('CSV reporting works', async function () {
    const {ticketInst} = await createStopsTripsUsersTickets(company.id)

    await m.Transaction.create({
      committed: true,
      transactionItems: [
        {itemType: 'ticketSale', itemId: ticketInst.id, credit: 0},
      ],
    }, {
      include: [m.TransactionItem],
    })

    let adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['view-transactions'],
    })
    let headers = {
      authorization: `Bearer ${adminCreds.result.sessionToken}`,
    }

    const year = new Date().getFullYear() + 1

    // Get the ticket reports
    // Dates OK
    let defaultQuery = {
      perPage: 100,
      page: 1,
      orderBy: 'createdAt',
      order: 'desc',
      tripStartDate: new Date(`${year}-03-01`).getTime(),
      tripEndDate: new Date(`${year}-03-02`).getTime(),
      statuses: JSON.stringify(['valid']),
      format: 'csv',
    }
    let ticketReport = await server.inject({
      method: 'GET',
      url: '/custom/wrs/report?' + querystring.stringify(defaultQuery),
      headers,
    })
    expect(ticketReport.headers['content-type']).startsWith('text/csv')
    expect(ticketReport.statusCode).equal(200)
    expect(ticketReport.result.split('\n').length).least(3)
  })

  lab.test("Tickets should not be cascade deletable", async function () {
    const {tripInst} = await createStopsTripsUsersTickets(company.id)

    await tripInst.destroy()
      .then(() => {
        fail("Trip instance should not have been successfully destroyed")
      }, () => {
        // 'Test passed: ticket prevented trip destruction'
      })
  })

  lab.test("Invalid trip GET request -> 404", async function () {
    const response = await server.inject({
      method: 'GET',
      url: '/trips/44444444',
    })

    expect(response.statusCode).equal(404)
  })

  lab.test("Invalid trip DELETE request -> 404", async function () {
    let adminCreds = await loginAs('admin', {
      transportCompanyId: company.id,
      permissions: ['manage-routes'],
    })
    let headers = {
      authorization: `Bearer ${adminCreds.result.sessionToken}`,
    }
    const response = await server.inject({
      method: 'DELETE',
      url: '/trips/44444444',
      headers,
    })

    expect(response.statusCode).equal(404)
  })
})
