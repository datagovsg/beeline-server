import {updateTicketsWithDiscounts} from '../transactions/builder'
import assert from 'assert'
import _ from 'lodash'

/**
 * For the routes represented in the given items,
 * extract route tags that correspond to route credits,
 * namely those prefixed crowdstart and rp
 */
export async function routePassTagsFrom (items, models, transaction) {
  const uniqueUsers = _.uniq(items.map(it => it.item.userId))
  assert(uniqueUsers.length === 1, "Route passes can only be used from one user's accounts.")

  const uniqueCompanies = _.uniq(items.map(it => it.trip.route.transportCompanyId))
  assert(uniqueCompanies.length === 1, "Can only purchase from one company at a time")

  const userId = uniqueUsers[0]
  const companyId = uniqueCompanies[0]
  const tags = _.flatten(await Promise.all(
    _(items)
      .uniqBy(it => it.trip.routeId)
      .map(it => it.trip.route.tags.filter(t => t.startsWith('crowdstart-') || t.startsWith('rp-')))
      .map(tags => getEligibleTags(userId, companyId, models, transaction, tags))
      .value()
  ))
  return tags.filter(Boolean)
}

async function getEligibleTags (userId, companyId, models, transaction, tags) {
  const sortedTags = _.sortBy(tags)
  if (!userId) {
    return sortedTags
  } else {
    const passes = await Promise.all(sortedTags.map(
      tag => models.RoutePass.find({
        where: {userId, companyId, tag, status: 'valid'}, transaction
      })
    ))
    return passes.map(pass => pass ? pass.tag : undefined).filter(Boolean)
  }
}

export async function applyRoutePass (tb, tag) {
  const eligibleTickets = tb.items.filter(item =>
    item.trip.route.tags.includes(tag) &&
    item.transactionItem.notes.outstanding > 0
  )
  if (eligibleTickets.length === 0) {
    return tb
  }

  const uniqueUsers = _.uniq(tb.items.map(it => it.item.userId))
  assert(uniqueUsers.length === 1, "Credits can only be deducted from one user's accounts.")

  const uniqueCompanies = _.uniq(tb.items.map(it => it.trip.route.transportCompanyId))
  assert(uniqueCompanies.length === 1, "Can only purchase from one company at a time")

  const userId = uniqueUsers[0]
  const companyId = uniqueCompanies[0]
  const availablePasses = await tb.models.RoutePass.findAll({
    where: {userId, companyId, tag, status: 'valid'},
    order: 'id',
    transaction: tb.transaction
  })

  if (availablePasses.length === 0) {
    return tb
  }

  const passesUsed = availablePasses.slice(0, Math.min(availablePasses.length, eligibleTickets.length))
  const ticketsBoughtWithPass = eligibleTickets.slice(0, passesUsed.length)
  const discountValues = ticketsBoughtWithPass.map(ticket => {
    assert(typeof ticket.transactionItem.notes.outstanding === 'number')
    return ticket.transactionItem.notes.outstanding
  })

  if (passesUsed.length === 0) {
    return tb
  } else {
    // Update the ticket data
    updateTicketsWithDiscounts(ticketsBoughtWithPass, `[route-pass ${tag}]`, discountValues, true)

    for (const [pass, ticket, discountValue] of _.zip(passesUsed, ticketsBoughtWithPass, discountValues)) {
      const routePassPurchaseTransactionItem = await tb.models.TransactionItem.find({ // eslint-disable-line no-await-in-loop
        where: {
          itemType: 'routePass',
          itemId: pass.id,
          debit: {$lt: 0},
        },
        transaction: tb.transaction,
      })
      tb.transactionItemsByType.routePass = tb.transactionItemsByType.routePass || []
      tb.transactionItemsByType.routePass.push({
        itemType: 'routePass',
        itemId: pass.id,
        debit: routePassPurchaseTransactionItem.credit,
        notes: {tickets: { [ticket.id]: discountValue }}
      })
      // The ticket price may differ from that of the route pass,
      // So if there's residual, book it as a separate debit item.
      const residual = discountValue - routePassPurchaseTransactionItem.creditF
      if (Math.abs(residual) > 0.001) {
        const residualAccount = await tb.models.Account.getByName('Route Pass / Trip Price Discrepency', { // eslint-disable-line no-await-in-loop
          transaction: tb.transaction
        })
        tb.transactionItemsByType.account = tb.transactionItemsByType.account || []
        tb.transactionItemsByType.account.push({
          itemType: 'account',
          itemId: residualAccount.id,
          debit: residual,
          notes: {tickets: { [ticket.id]: discountValue }}
        })
      }
    }

    if (!tb.dryRun) {
      tb.undoFunctions.push(transaction => Promise.all(
        passesUsed.map(
          pass => pass.update(
            { ...pass.toJSON(), status: 'valid' },
            { transaction }
          )
        )
      ))
      await Promise.all(
        _.zip(passesUsed, ticketsBoughtWithPass).map(
          ([pass, ticket]) => pass.update(
            { status: 'void', notes: { ...pass.notes, ticketId: ticket.id } },
            { transaction: tb.transaction }
          )
        )
      )
    }

    return tb
  }
}
