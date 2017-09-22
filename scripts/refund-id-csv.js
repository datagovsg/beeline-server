const {db, models: m} = require('../src/lib/core/dbschema')();
const _ = require('lodash');
const csv = require('fast-csv');

async function dumpRefundsOriginalTransactions (fromWhen, toWhen) {
  // Find only committed transactions
  var transactions = await m.Transaction.findAll({
    where: {
      createdAt: {$gte: fromWhen, $lte: toWhen},
      committed: true
    },
    include: [m.TransactionItem]
  });

  transactions = transactions
    // Get only transactions with refunds
    .filter(t => _.some(t.transactionItems, ti => ti.itemType === 'refundPayment'))
    .map(t => t.toJSON());

  var refundPaymentIds = _(transactions)
    .map(t => t.transactionItems)
    .flatten()
    .filter(t => t.itemType === 'refundPayment')
    .map(t => t.itemId)
    .value();

  var refundPayments = await m.RefundPayment.findAll({
    where: {id: {$in: refundPaymentIds}},
    raw: true
  });
  var refundPaymentsById = _.keyBy(refundPayments, 'id');

  var ticketsWithRefund = _(transactions)
    .map(t => t.transactionItems)
    .flatten()
    .filter(ti => ti.itemType === 'ticketRefund')
    .value();

  var refundTicketIds = ticketsWithRefund.map(tk => tk.itemId);
  var associatedTransactions = await m.TransactionItem.findAll({
    where: {
      itemType: 'ticketSale',
      itemId: {$in: refundTicketIds}
    },
    attributes: ['itemId', 'transactionId'],
    include: [
      {
        model: m.Transaction,
        where: {committed: true},
        attributes: []
      }
    ],
    raw: true
  });
  var saleTransactionIdByTicketId = _.keyBy(associatedTransactions, 'itemId');

  // Output [stripeRefundId, transactionId]
  var output = [];
  for (let transaction of transactions) {
    var refundId = transaction.transactionItems.find(ti => ti.itemType === 'refundPayment').itemId;

    for (let ti of transaction.transactionItems) {
      if (ti.itemType === 'ticketRefund' && ti.itemId in saleTransactionIdByTicketId) {
        output.push([
          refundPaymentsById[refundId].paymentResource,
          transaction.id,
          saleTransactionIdByTicketId[ti.itemId].transactionId
        ]);
      }
    }
  }

  return output;
}

dumpRefundsOriginalTransactions('2016-05-01', '2016-09-01')
.then((result) => {
  var csvStream = csv.createWriteStream({headers: true});

  csvStream.pipe(process.stdout);
  for (let row of result) {
    csvStream.write({
      stripeRefundId: row[0],
      originalTransaction: row[1],
      refundTransaction: row[2]
    });
  }
  csvStream.end();
})
.catch((err) => {
  console.error(err.stack);
});
