import _ from "lodash"

import {TransactionError} from '../transactions'
import {TransactionBuilder} from '../transactions/builder'

export async function applyPromoCode (tb, promoCode, type) {
  const clone = new TransactionBuilder(tb)

  // Identify applicable promotions
  const promotionInstances = await tb.models.Promotion.findAll({
    where: { code: promoCode.code, type },
    transaction: tb.transaction,
    raw: true,
  })
  const promotionCalculations = promotionInstances
    .map(promoDef => createCalculation(
      promoDef.type, tb, promoDef.params, promoCode.options,
      promoDef.description, promoDef.id
    )
  )

  await Promise.all(promotionCalculations.map(p => p.initialize()))

  const qualifiedPromotions = _(promotionCalculations)
    .filter(promo => promo.isQualified())
    .orderBy([promotion => _.sum(promotion.computeDiscountsAndRefunds()[0])], ['desc'])
    .value()

  if (promoCode.code === '' && qualifiedPromotions.length === 0) {
    return tb // No Change
  } else if (qualifiedPromotions.length === 0) {
    const hasOutstandingItems = tb.items.filter(ti => !ti.transactionItem || ti.transactionItem.notes.outstanding > 0).length > 0
    if (!hasOutstandingItems) {
      return tb
    } else {
      throw new TransactionError(`Sorry, the promo code entered is invalid`, { source: 'promoCode' })
    }
  }

  const promotion = qualifiedPromotions[0]
  const {description, promotionId} = promotion

  const userIds = _(tb.items.map(i => i.userId)).uniq().value()
  const userId = userIds[0]

  // Check if usage limit for promotion code has been reached
  // Ensure that promotions have a usageLimit defined, catch them otherwise
  TransactionError.assert(promotion.params && promotion.params.usageLimit,
    'Error processing promoCode: undefined usageLimit', { source: 'promoCode' })

  const { globalLimit, userLimit } = promotion.params.usageLimit

  // Terminate transaction if user is using a disabled promoCode
  TransactionError.assert(
    (globalLimit > 0 || globalLimit === null) && (userLimit > 0 || userLimit === null),
      `The promo code is inactive`, { source: 'promoCode' }
  )

  if (globalLimit) {
    let globalUsed = await tb.models.PromoUsage.getGlobalPromoUsage(
      promotionId, {transaction: tb.transaction}
    )
    TransactionError.assert(globalLimit > globalUsed,
      `This promotion has been fully redeemed`, { source: 'promoCode' })
  }

  let userUsed = await tb.models.PromoUsage.getUserPromoUsage(
    promotionId, userId, {transaction: tb.transaction}
  )

  if (userLimit) {
    TransactionError.assert(userLimit > userUsed,
      `You have already fully redeemed this promotion`,
      { source: 'promoCode' }
    )
  }

  const itemLimit = type !== 'RoutePass' && userLimit ? userLimit - userUsed : null

  // Run hooks
  await promotion.preApplyHooks()

  promotion.removePaidAndApplyLimits(itemLimit)
  const filteredItems = promotion.getValidItems()

  const usedCount = type === 'RoutePass' ? 1 : filteredItems.length
  const [discountValues, refundAdjustments] = promotion.computeDiscountsAndRefunds()

  // keyBy(appliedDiscounts, item.id)
  const discountValueMap = _(filteredItems)
    .map(item => item.id)
    .zip(discountValues)
    .fromPairs()
    .value()

  // keyBy(refundAdjustments, item.id)
  const refundAdjustmentMap = _(filteredItems)
    .map(item => item.id)
    .zip(refundAdjustments)
    .fromPairs()
    .value()

  await promotion.postApplyHooks()

  if (!tb.dryRun && tb.committed) {
    await promotion.commitHooks()
    if (promotion.params.usageLimit.userLimit) {
      await tb.models.PromoUsage.addUserPromoUsage(promotionId,
        userId, usedCount, { transaction: tb.transaction })
    }
  }

  // Add a discount entry to the transaction
  TransactionError.assert(!clone.transactionItemsByType.discount,
    "Composing multiple discounts is currently not supported!")

  clone.transactionItemsByType.discount = clone.transactionItemsByType.discount || []
  clone.transactionItemsByType.discount.push({
    itemType: 'discount',
    debit: _.sum(discountValues),
    discount: {
      description,
      code: promoCode.code,
      userOptions: promoCode.options,
      discountAmounts: discountValueMap,
      refundAmounts: refundAdjustmentMap,
      promotionParams: promotion.params,
      promotionId
    },
    notes: { tickets: discountValueMap }
  })

  // Update the description
  const discountDescriptions = _(clone.transactionItemsByType.discount || [])
    .map(item => `${item.discount.code} -$${Number(item.debit).toFixed(2)}`)
    .join(';')
  clone.description = clone.description + ' ' + discountDescriptions

  clone.undoFunctions.push(async (t) => {
    if (promotion.params.usageLimit.userLimit) {
      await tb.models.PromoUsage.subtractUserPromoUsage(promotionId,
        userId, usedCount, { transaction: t })
    }
    await promotion.undoHooks({transaction: t})
  })

  return clone
}

export const qualifiers = {
  Promotion: require('./functions/ticketDiscountQualifiers'),
  RoutePass: require('./functions/routePassDiscountQualifiers'),
}

const promotions = {
  Promotion: require('./Promotion').Promotion,
  RoutePass: require('./RoutePass').RoutePass,
}

export function createCalculation (promoType, transactionBuilder, params, options, description, promotionId) {
  if (!promotions[promoType] || !qualifiers[promoType]) return null
  const qualifiersForType = qualifiers[promoType]
  return new promotions[promoType](transactionBuilder, params, options, description, promotionId, qualifiersForType)
}
