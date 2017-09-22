const {db, models: m} = require('../src/lib/core/dbschema')();
const _ = require('lodash');
const csv = require('fast-csv');

async function dumpChargeIds (fromWhen, toWhen) {
  var transactionItems = await m.TransactionItem.findAll({
    where: {
      itemType: 'payment'
    },
    include: [
      {
        model: m.Transaction,
        where: {committed: true},
        attributes: []
      }
    ],
    raw: true
  });
  var payments = await m.Payment.findAll({
    where: {id: {$in: transactionItems.map(ti => ti.itemId)}},
    raw: true
  });
  var paymentsById = _.keyBy(payments, 'id');

  return transactionItems.map(ti => [
    paymentsById[ti.itemId] && paymentsById[ti.itemId].paymentResource,
    ti.transactionId
  ]);
}

dumpChargeIds('2016-05-01', '2016-09-01')
.then((result) => {
  var csvStream = csv.createWriteStream({headers: true});

  csvStream.pipe(process.stdout);
  for (let row of result) {
    csvStream.write({
      chargeId: row[0],
      originalTransaction: row[1],
    });
  }
  csvStream.end();
})
.catch((err) => {
  console.error(err.stack);
});
