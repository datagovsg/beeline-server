import {distribute} from '../transactions/payment'
import {TransactionBuilder, outstandingAmounts, updateTicketsWithDiscounts} from '../transactions/builder'
import assert from 'assert'
import _ from 'lodash'

export async function applyCredits (tb) {
  const uniqueUsers = _.uniq(tb.items.map(it => it.item.userId))

  assert(uniqueUsers.length === 1, "Credits can only be deducted from one user's accounts.")

  const userId = uniqueUsers[0]

  const creditInst = await tb.models.Credit.get(userId, {transaction: tb.transaction})
  const availableCredits = parseFloat(creditInst.balance)

  assert.strictEqual(typeof availableCredits, 'number')

  const eligibleTickets = tb.items
  const prices = outstandingAmounts(eligibleTickets)

  const discountValues = distribute(availableCredits, prices)
  const discountAmount = _.sum(discountValues)

  // Update the ticket data
  updateTicketsWithDiscounts(eligibleTickets, `[credit]`, discountValues, true)

  if (discountAmount === 0) {
    return tb
  } else {
    // FIXME: Ooops we should really add these as functions to be executed
    // when tb.build() is called. Not side-effect free :(
    if (!tb.dryRun) {
      await tb.models.Credit.subtractUserCredits(userId, discountAmount, {
        transaction: tb.transaction
      })
    }

    const clone = new TransactionBuilder(tb)
    const ticketIdToDiscountMap = _.fromPairs(_.zip(eligibleTickets.map(i => i.ticket.id), discountValues))

    clone.transactionItemsByType.userCredit = tb.transactionItemsByType.userCredit || []
    clone.transactionItemsByType.userCredit.push({
      itemType: 'userCredit',
      itemId: creditInst.userId,
      debit: discountAmount,
      notes: {
        tickets: ticketIdToDiscountMap
      }
    })

    const cogsAccount = await tb.models.Account.getByName("Cost of Goods Sold", {
      transaction: tb.transaction
    })

    // assume each purchase only deals with one transportCompany
    assert.strictEqual(_.uniq(eligibleTickets.map(t => t.trip.route.transportCompanyId)).length, 1)
    const companyId = eligibleTickets[0].trip.route.transportCompanyId

    clone.transactionItemsByType.account = tb.transactionItemsByType.account || []
    clone.transactionItemsByType.account.push({
      itemType: 'account',
      itemId: cogsAccount.id,
      debit: discountAmount,
    })

    clone.transactionItemsByType.payables = tb.transactionItemsByType.payables || []
    clone.transactionItemsByType.payables.push({
      itemType: 'payables',
      itemId: companyId,
      credit: discountAmount,
    })

    if (!tb.dryRun) {
      clone.undoFunctions.push((t) =>
        tb.models.Credit.addUserCredits(userId, discountAmount, {transaction: t}))
    }
    return clone
  }
}

export async function refund (tb, previousTransactionItem, previousTicketId) {
  const clone = new TransactionBuilder(tb)
  const {models, transaction} = tb

  assert(previousTransactionItem.itemType === 'userCredit',
    `Trying to refund credits from an item of type ${previousTransactionItem.itemType}`)

  const amountToRefund = previousTransactionItem.notes.tickets[previousTicketId]
  assert(typeof (amountToRefund) === 'number' && isFinite(amountToRefund),
    `The previous transaction specified an incorrect amount to refund`)

  await (await models.Credit.findById(previousTransactionItem.itemId, {transaction}))
    .increment('balance', {by: amountToRefund, transaction})

  clone.transactionItemsByType.userCredit = clone.transactionItemsByType.userCredit || []
  clone.transactionItemsByType.userCredit.push({
    itemType: 'userCredit',
    itemId: previousTransactionItem.itemId,
    credit: amountToRefund
  })

  const companyId = previousTransactionItem.itemId

  clone.transactionItemsByType.payables = clone.transactionItemsByType.payables || []
  clone.transactionItemsByType.payables.push({
    itemType: 'payables',
    itemId: companyId,
    debit: amountToRefund,
  })

  const cogsAccount = await tb.models.Account.getByName("Cost of Goods Sold", {
    transaction: tb.transaction
  })

  clone.transactionItemsByType.account = clone.transactionItemsByType.account || []
  clone.transactionItemsByType.account.push({
    itemType: 'account',
    itemId: cogsAccount.id,
    credit: amountToRefund,
  })

  return clone
}
