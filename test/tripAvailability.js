const Lab = require("lab")
const lab = exports.lab = Lab.script()

const {expect} = require("code")

const {models} = require('../src/lib/core/dbschema')()
const {resetTripInstances} = require("./test_common")
const {createUsersCompaniesRoutesAndTrips} = require("./test_data")

lab.experiment("Trip availability update hooks in Ticket", () => {
  var userInstance, tripInstances

  lab.before({timeout: 15000}, async () => {
    ({userInstance, tripInstances} = await createUsersCompaniesRoutesAndTrips(models))
  })

  lab.afterEach(async () => resetTripInstances(models, tripInstances))

  const createTicket = () => models.Ticket.create({
    userId: userInstance.id,
    tripId: tripInstances[0].id,
    boardStopId: tripInstances[0].tripStops[0].id,
    alightStopId: tripInstances[0].tripStops[4].id,
    status: 'valid',
  })

  lab.test('Ticket creation decrements trip availability', async () => {
    await createTicket()
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity - 1)
  })

  lab.test('Ticket status change adjusts trip availability', async () => {
    const ticket = await createTicket()
    await ticket.update({ status: 'void' })
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity)
    await ticket.update({ status: 'valid' })
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity - 1)
  })

  lab.test('Ticket re-valid -> no availability change', async () => {
    const ticket = await createTicket()
    await ticket.update({ status: 'pending' })
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity - 1)
  })

  lab.test('Ticket re-invalid -> no availability change', async () => {
    const ticket = await createTicket()
    await ticket.update({ status: 'void' })
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity)
    await ticket.update({ status: 'withdrawn' })
    await tripInstances[0].reload()
    expect(tripInstances[0].seatsAvailable).equal(tripInstances[0].capacity)
  })

  lab.test('afterBulkUpdate is disallowed', async () => {
    const ticket = await createTicket()
    try {
      await models.Ticket.update(
        { status: 'void' },
        { where: { id: ticket.id }}
      )
      throw new Error('Test Failure')
    } catch (err) {
      expect(err.name).equal('TransactionError')
    }
  })
})
