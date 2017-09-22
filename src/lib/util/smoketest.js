const email = require('./email')

const ticketCountAgreesWithAvailability = db => db.query(
  `
  WITH availability as (SELECT trips.id AS "tripId",
      trips.capacity AS "seatsTotal",
      (trips.capacity - count("tripStops".id))::integer AS "seatsAvailable",
      count("tripStops".id)::integer AS "seatsBooked"
     FROM trips
       LEFT JOIN (( SELECT tickets_1.id AS "ticketId",
              tickets_1."userId",
              tickets_1."boardStopId",
              tickets_1."alightStopId",
              tickets_1.status
             FROM tickets tickets_1
            WHERE tickets_1.status::text IN ('valid'::text, 'pending'::text, 'bidded'::text)) tickets
       JOIN "tripStops" ON tickets."boardStopId" = "tripStops".id) ON trips.id = "tripStops"."tripId"
    GROUP BY trips.id, trips.capacity)
  select t.id, capacity, t."seatsAvailable" as "tripSeatsAvailable", a."seatsAvailable", r.label, r.from, r.to
  from routes r, trips t, availability a
  where t.id = a."tripId"
  and t."seatsAvailable" != a."seatsAvailable"
  and t.date > now()
  and t."routeId" = r.id
  and not (r.tags @> ARRAY['crowdstart']::varchar[])
  `,
  { type: db.QueryTypes.SELECT }
)

const allPaymentsHaveData = db => db.query(
  `select t.*, p."paymentResource"
  from tickets t, "transactionItems" tip, "transactionItems" tis, payments p
  where p.data is null
  and p.id = tip."itemId" and tip."itemType" = 'payment'
  and tip."transactionId" = tis."transactionId"
  and tis."itemId" = t.id and tis."itemType" = 'ticketSale'
  and t.status = 'valid' and t."createdAt" > '2017-01-01'
  order by t."createdAt" desc
  `,
  { type: db.QueryTypes.SELECT }
)

export function conductSmokeTestAndEmail (db = require('../core/dbschema')().db) {
  return Promise.all([
    ticketCountAgreesWithAvailability(db),
    allPaymentsHaveData(db)
  ])
    .then(async ([badAvailTrips, badTickets]) => {
      var mailText = ""
      if (badAvailTrips.length > 0) {
        mailText +=
          "The following trips report seat availability different from what is actually available:\n" +
          badAvailTrips.map(t => JSON.stringify(t) + "\n")
      }
      if (badTickets.length > 0) {
        mailText += "\n" +
          "The following tickets lack payments:\n" +
          badTickets.map(t => JSON.stringify(t) + "\n")
      }

      console.log(mailText || 'Smoketest complete - No Problems')
      if (mailText) {
        const mail = {
          from: 'smoketest-noreply@beeline.sg',
          to: process.env.EMAIL || 'admin@beeline.sg',
          subject: 'Smoke test ' + new Date().toISOString().split('T')[0] + ': ' +
            (mailText ? 'Problems Found' : 'No Problems'),
          text: mailText,
        }

        email
          .sendMail(mail)
          .then(info => console.log('Mail sent.'))
          .catch(err => console.log('Mail send failure: ' + err))
      }
    })
    .catch(err => console.error(err))
}
