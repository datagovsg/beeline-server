import Joi from 'joi'
import assert from 'assert'
import _ from 'lodash'

import {roundToNearestCent} from '../../util/common'
import {distribute} from '../../transactions/payment'

/**
 * All discounting functions are generator functions that
 * takes in a param object and return a discouting function that
 * takes in the filtered list from discount.qualify() and works out
 * the amount of discount to apply to each item on the list
 */
export const discountingFunctions = {
  childRate (params) {
    return (items, options) => {
      return items.map(item => {
        assert(isFinite(item.trip.bookingInfo.childTicketPrice))
        assert(parseFloat(item.trip.bookingInfo.childTicketPrice) < item.trip.priceF)
        return item.trip.priceF - item.trip.bookingInfo.childTicketPrice
      })
    }
  },

  /**
   * Single discount rate applied across all tickets
   * @param {number} rate
   */
  simpleRate (params) {
    Joi.assert(params, {
      rate: Joi.number().min(0).max(1).required()
    })

    return (items, options) => {
      return items.map(item => roundToNearestCent(parseFloat(item.price) * params.rate))
    }
  },

  /**
   * All tickets will be discounted the same amount
   * @param {number} fixed
   */
  simpleFixed (params) {
    Joi.assert(params, {
      fixed: Joi.number().min(0).precision(2).required()
    })
    return (items, options) => {
      return items.map(it => Math.min(+params.fixed, +it.price))
    }
  },

  /**
   * All tickets will be discounted the same amount
   * @param {number} fixed
   */
  flatPrice (params) {
    Joi.assert(params, {
      price: Joi.number().min(0).precision(2).required()
    })
    return (items, options) => {
      return items.map(it => roundToNearestCent(Math.max(0, it.price - params.price)))
    }
  },

  /**
   * Fixed prices (e.g. Uber's $5 promo)
   * @param {number} fixed
   */
  fixedPrice (params) {
    return (items, options) => {
      Joi.assert(options, {
        price: Joi.number().min(0).precision(2).required()
      })

      return items.map(it => parseFloat(it.price) - parseFloat(options.price))
    }
  },

  /**
   * Fixed price for the entire transaction
   * @param {number} fixed
   */
  fixedTransactionPrice (params) {
    Joi.assert(params, {
      price: Joi.number().min(0).precision(2).required()
    })
    return (items, options) => {
      const totalValue = roundToNearestCent(_.sumBy(items, item => parseFloat(item.price)))
      const totalDiscount = totalValue - params.price
      return totalDiscount <= 0
        ? items
        : distribute(totalDiscount, items.map(it => it.price))
    }
  },

  /**
   * Different discount rate depending on number of tickets purchased
   * schedule is an sorted array of (quantity, discount rate) pairs
   * the function will take the highest qty in the schdule
   * that is lower or equal to the number of ticket purchase
   * and apply the matching discount rate to all tickets
   */
  tieredRateByQty (params) {
    Joi.assert(params, {
      schedule: Joi.array().min(1).items(
        Joi.array().ordered(
          Joi.number().integer().min(0).required(),
          Joi.number().min(0).max(1).required()
        )
      ).required()
    })
    assertTiersAreIncreasing(params.schedule)

    return (items, options) => {
      const match = findMatchingTier(items.length, params.schedule)
      return items.map(item => roundToNearestCent(parseFloat(item.price) * match))
    }
  },

  /**
   * Discount depends on number of tickets purchased
   * schedule is an sorted array of (quantity, discount amount) pairs
   * the function will take the highest qty in the schdule
   * that is lower or equal to the number of ticket purchase
   * and apply the discount amount SPREAD EVENLY OVER ALL TICKETS
   */
  tieredFixedByQty (params) {
    Joi.assert(params, {
      schedule: Joi.array().min(1).items(
        Joi.array().ordered(
          Joi.number().integer().min(0).required(),
          Joi.number().min(0).precision(2).required()
        )
      ).required()
    })
    assertTiersAreIncreasing(params.schedule)

    return (items, options) => {
      const match = findMatchingTier(items.length, params.schedule)
      return distribute(match, items.map(it => 1))
    }
  },

  /**
   * Different discount rate depending on total purchase value
   * schedule is an sorted array of (value, discount rate) pairs
   * the function will take the highest value in the schdule
   * that is lower or equal to the total purchase value
   * and apply the matching discount rate to all tickets
   */
  tieredRateByTotalValue (params) {
    Joi.assert(params, {
      schedule: Joi.array().min(1).items(
        Joi.array().ordered(
          Joi.number().min(0).required(),
          Joi.number().min(0).max(1).required()
        )
      ).required()
    })
    assertTiersAreIncreasing(params.schedule)

    return (items, options) => {
      const totalValue = roundToNearestCent(_.sumBy(items, item => parseFloat(item.price)))
      const match = findMatchingTier(totalValue, params.schedule)
      return items.map(item => roundToNearestCent(parseFloat(item.price) * match))
    }
  },

  /**
   * Discounts depends on total purchase value
   * schedule is an sorted array of (value, discount rate) pairs
   * the function will take the highest value in the schdule
   * that is lower or equal to the total purchase value
   * and apply the discount amount SPREAD EVENLY OVER ALL TICKETS
   */
  tieredFixedByTotalValue (params) {
    Joi.assert(params, {
      schedule: Joi.array().min(1).items(
        Joi.array().ordered(
          Joi.number().min(0).required(),
          Joi.number().min(0).precision(2).required()
        )
      ).required()
    })
    assertTiersAreIncreasing(params.schedule)

    return (items, options) => {
      const totalValue = roundToNearestCent(_.sumBy(items, item => parseFloat(item.price)))
      const match = findMatchingTier(totalValue, params.schedule)
      return distribute(match, items.map(it => 1))
    }
  },

  /**
   * Ticket is free
   * 100% discounted
   */
  freeTicket (params) {
    return (items, options) => {
      return items.map(item => parseFloat(item.price))
    }
  }
}

/**
 * All refunding functions are generator functions that
 * takes in a param object and return a refunding function that
 * acts on the filtered list of items from discount.qualify()
 * and applied discount amounts from discount.computeDiscount(),
 * calculating adjustment on the refund amount for each item on the list
 */
export const refundingFunctions = {
  /**
   * Amount refunded is the amount AFTER discount
   */
  refundDiscountedAmt (items, options, appliedDiscounts) {
    return [...appliedDiscounts]
  },

  /**
   * Amount refunded is the amount BEFORE discount
   */
  refundOriginalAmt (items, options, appliedDiscounts) {
    return Array(appliedDiscounts.length).fill(0)
  },

  /**
   * Assumes all items receive the same amount of discount
   * and refunds ticket price less this AMORTIZED AMOUNT
   */
  refundAverageAmt (items, options, appliedDiscounts) {
    const n = appliedDiscounts.length
    const totalDiscount = _.sum(appliedDiscounts)
    const splitAmt = roundToNearestCent(totalDiscount / n)
    const refundAdjustments = Array(n).fill(splitAmt)
    refundAdjustments[n - 1] = totalDiscount - (n - 1) * splitAmt
    return refundAdjustments
  },
}

function assertTiersAreIncreasing (tiers) {
  for (let i = 1; i < tiers.length; i++) {
    assert(tiers[i][0] > tiers[i - 1][0],
      `Tiers are improperly defined. Tier at position ${i} = ${tiers[i][0]} ` +
      `is smaller than/equal to tier at position ${i - 1} = ${tiers[i - 1][0]}`)
  }
}

function findMatchingTier (amount, tiers, fallback = 0) {
  if (tiers.length === 0) {
    return fallback
  } else {
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i][0] > amount) {
        if (i === 0) { return fallback } else { return tiers[i - 1][1] }
      }
    }

    return tiers[tiers.length - 1][1]
  }
}
