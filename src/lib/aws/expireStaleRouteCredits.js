const {db, models} = require('../core/dbschema')()
const {TransactionBuilder} = require('../transactions/builder')
/**
* Finds and expires rp-prefixed route credits from a specified company
* older than a specified date
*/
exports.handler = function (event, context, callback) {
  return db.transaction(transaction => {
    return expireRoutePasses(transaction)
      .then(affectedEntries => insertExpiredCreditTransactions(transaction, affectedEntries))
      .then(payload => callback(null, JSON.stringify(payload, null, 2)))
      .catch(callback)
  })
}

function expireRoutePasses (transaction) {
  return db.query(
    `
    UPDATE
      "routePasses" rp
    SET
      status = 'expired', notes = notes || ('{"expiredAt": "${new Date()}"}')::jsonb
    WHERE
      status = 'valid'
      AND rp.tag LIKE 'rp-%'
      AND rp."companyId" = :transportCompanyId
      AND now()::date - rp."createdAt"::date > :maxDays
    RETURNING *
    `,
    {
      replacements: {
        maxDays: process.env.MAX_DAYS,
        transportCompanyId: process.env.TRANSPORT_COMPANY_ID
      },
      raw: true,
      transaction,
    }
  )
}


function insertExpiredCreditTransactions (transaction, affectedEntries) {
  return models.Account.getByName('Upstream Route Credits', {attributes: ['id'], transaction})
    .then(account => {
      return Promise.all(affectedEntries[0].map(entry => {
        const tb = new TransactionBuilder({
          db, models, transaction,
          committed: true, dryRun: false,
          creator: {type: 'system', id: 'expireRouteCredits'}
        })

        // On the debit side
        tb.lineItems = null
        tb.description = `Expire route pass ${entry.id}`

        const amount = entry.notes.price

        tb.transactionItemsByType = {
          routePass: [{
            itemType: 'routePass',
            itemId: entry.id,
            debit: amount,
          }],
          account: [{
            itemType: 'account',
            itemId: account.id,
            credit: amount
          }]
        }

        return tb.build({type: 'routePassExpiry'}).then(([t]) => [entry, t.toJSON()])
      }))
    })
}
