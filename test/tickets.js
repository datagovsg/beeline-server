import {expect} from 'code'
import Lab from 'lab'

import server from '../src/index'
import {resetTripInstances, createStripeToken, randomEmail} from './test_common'
import {createUsersCompaniesRoutesAndTrips} from './test_data'

const {models: m} = require('../src/lib/core/dbschema')()

export var lab = Lab.script()

lab.experiment('tickets', function () {
  let userInstance
  let companyInstance
  let tripInstances
  let userToken

  lab.before({timeout: 20000}, async () => {
    ({userInstance, companyInstance, tripInstances} = await createUsersCompaniesRoutesAndTrips(m))
    userToken = {authorization: `Bearer ${userInstance.makeToken()}`}

    const purchaseItems = [{
      tripId: tripInstances[0].id,
      boardStopId: tripInstances[0].tripStops[0].id,
      alightStopId: tripInstances[0].tripStops[4].id,
    }, {
      tripId: tripInstances[1].id,
      boardStopId: tripInstances[1].tripStops[0].id,
      alightStopId: tripInstances[1].tripStops[4].id,
    }, {
      tripId: tripInstances[2].id,
      boardStopId: tripInstances[2].tripStops[0].id,
      alightStopId: tripInstances[2].tripStops[4].id,
    }, {
      tripId: tripInstances[3].id,
      boardStopId: tripInstances[3].tripStops[0].id,
      alightStopId: tripInstances[3].tripStops[4].id,
    }, {
      tripId: tripInstances[4].id,
      boardStopId: tripInstances[4].tripStops[0].id,
      alightStopId: tripInstances[4].tripStops[4].id,
    }]

    const previewResponse = await server.inject({
      method: 'POST',
      url: '/transactions/tickets/quote',
      payload: {
        trips: purchaseItems,
      },
      headers: userToken
    })
    expect(previewResponse.statusCode).to.equal(200)

    const saleResponse = await server.inject({
      method: 'POST',
      url: '/transactions/tickets/payment',
      payload: {
        trips: purchaseItems,
        stripeToken: await createStripeToken()
      },
      headers: userToken
    })
    expect(saleResponse.statusCode).to.equal(200)
  })

  /*
    Delete all the tickets after each transaction so that
    we don't get 'user already has ticket' errors, or unexpected
    capacity errors
  */
  lab.after(async () => resetTripInstances(m, tripInstances))

  lab.test('query and update tickets with transportCompanyId', {timeout: 10000}, async function () {
    // pull tickets
    var ticketResponse = await server.inject({
      method: 'GET',
      url: '/tickets',
      headers: userToken
    })

    expect(ticketResponse.statusCode).to.equal(200)
    expect(ticketResponse.result.length).equal(5)

    const adminInstance = await m.Admin.create({
      email: randomEmail()
    })
    await adminInstance.addTransportCompany(companyInstance.id, {permissions: ['issue-tickets']})
    const adminToken = {authorization: `Bearer ${adminInstance.makeToken()}`}

    const ticketId = ticketResponse.result[0].id

    const ticketStatusTo = async status => server.inject({
      method: 'PUT',
      url: `/tickets/${ticketId}/status`,
      headers: adminToken,
      payload: { status },
    })

    const ticket = await m.Ticket.findById(ticketId)

    expect((await ticketStatusTo('failed')).statusCode).equal(400)
    expect((await ticketStatusTo('void')).statusCode).equal(200)
    expect((await ticket.reload()).status).equal('void')
    expect((await ticketStatusTo('valid')).statusCode).equal(200)
    expect((await ticket.reload()).status).equal('valid')
    await ticket.update({ status: 'failed' })
    expect((await ticketStatusTo('void')).statusCode).equal(400)

    var transportCompanyId = companyInstance.id + 1

    var ticket2Response = await server.inject({
      method: 'GET',
      url: `/tickets?transportCompanyId=${transportCompanyId}`,
      headers: userToken
    })

    expect(ticket2Response.statusCode).to.equal(200)
    expect(ticket2Response.result.length).equal(0)
  })
})
