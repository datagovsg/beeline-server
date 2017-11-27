import Joi from 'joi'
import assert from 'assert'
import _ from 'lodash'

/**
 * All qualifying functions are generator functions that
 * takes in a param object and return a qualifying function that
 * acts on the list of items from purchaseOrder.getItems(),
 * filtering it based on selected criteria
 */
export const qualifyingFunctions = {
  /**
   * Limit to routes by one company
   * @param {number} companyId
   */
  limitByCompany: function (params) {
    Joi.assert(params, {
      companyId: Joi.number().integer().required()
    })

    return (items, options) => {
      return items.filter(item => item.trip.route.transportCompanyId === params.companyId)
    }
  },

  /**
   * Limit to certain routes
   * @param {number[]} routeIds
   */
  limitByRoute: function (params) {
    Joi.assert(params, {
      routeIds: Joi.array().min(1).items(Joi.number().integer()).required()
    })

    return (items, options) => {
      return items.filter(item => params.routeIds.indexOf(item.trip.routeId) > -1)
    }
  },

  /**
   * Limit to certain routes
   * @param {number[]} routeIds
   */
  limitByRouteTags: function (params) {
    Joi.assert(params, {
      tags: Joi.array().min(1).items(Joi.string()).required()
    })

    return (items, options) => {
      return items.filter(item => {
        var tags = item.trip.route.tags
        var intersection = _.intersection(tags, params.tags)

        return _.size(_.uniq(intersection)) === params.tags.length
      })
    }
  },

  /**
   * For limited period discounts
   * based on booking date
   * @param {date} startDate
   * @param {date} endDate
   * booking date to be provided as a @param {date} now on the options object
   */
  limitByPurchaseDate: function (params) {
    const validatedParams = Joi.attempt(params, {
      startDate: Joi.date().required(),
      endDate: Joi.date().required()
    })

    return (items, options) => {
      const now = new Date()
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
      if (
        (today < validatedParams.startDate.getTime()) ||
        (today > validatedParams.endDate.getTime())
      ) return []
      return items
    }
  },

  /**
   * For limited period discounts
   * based on trip day
   * @param {date} startDate
   * @param {date} endDate
   */
  limitByTripDate: function (params) {
    var {error, value: validatedParams} = Joi.validate(params, {
      startDate: Joi.date().required(),
      endDate: Joi.date().required()
    })

    assert(!error)

    return (items, options) => {
      return items.filter(item => {
        const tripDate = item.trip.date
        return (tripDate.getTime() >= validatedParams.startDate.getTime() &&
                tripDate.getTime() <= validatedParams.endDate.getTime())
      })
    }
  },

  /**
   * For limited period discounts
   * based on trip day
   * @param {int} day of week (0 is Sunday)
   */
  limitByTripDayOfWeek: function (params) {
    var {error, value: validatedParams} = Joi.validate(params, {
      0: Joi.boolean().required(),
      1: Joi.boolean().required(),
      2: Joi.boolean().required(),
      3: Joi.boolean().required(),
      4: Joi.boolean().required(),
      5: Joi.boolean().required(),
      6: Joi.boolean().required(),
    })

    assert(!error)

    return (items, options) => {
      return items.filter(item => {
        const tripDate = item.trip.date
        return validatedParams[tripDate.getUTCDay()]
      })
    }
  },

  limitByContactList (params, transactionBuilder) {
    const {error, value: validatedParams} = Joi.validate(params, {
      contactListId: Joi.number().integer().required()
    })

    assert(!error)

    return async (items, options) => {
      const contactList = await transactionBuilder.models.ContactList
        .findById(validatedParams.contactListId, {transaction: transactionBuilder.transaction})

      if (!contactList) {
        console.warn(`limitByContactList - Unrecognised contact list id: ${validatedParams.contactListId}`)
        return []
      }

      const telephoneListKeyed = _.keyBy(contactList.telephones)
      const emailListKeyed = _.keyBy(contactList.emails)

      const users = (await transactionBuilder.models.User
        .findAll({
          where: {id: {$in: items.map(i => i.ticket.userId)}},
          transaction: transactionBuilder.transaction,
          attributes: ['id', 'telephone', 'email', 'emailVerified']
        }))

      const recognized = users
        .filter(u =>
          (u.telephone && u.telephone in telephoneListKeyed) ||
          (u.email && u.emailVerified && u.email in emailListKeyed)
        )
        .map(u => u.id)

      return items.filter(item => recognized.indexOf(item.ticket.userId) !== -1)
    }
  },

  /**
   * Apply discount on any number of ticket
   * client provides a @param {integer} count on the options object
   * to indicate to server how many tickets should be discounted
   * tickets are sorted by their prices from cheapest to most expensive
   * cheaper tickets are discounted first
   */
  freeTickets (params) {
    return (items, options) => {
      Joi.assert(options, Joi.object().keys({
        count: Joi.number().integer().min(1).max(items.length).required()
      }).unknown())

      const sorted = _.sortBy(items, item => parseFloat(item.price))
      return sorted.slice(0, options.count)
    }
  },

  /**
   * For children discount
   * Children rate applied for tickets with child flag set
   */
  childTickets (params) {
    return (items, options) => {
      return items.filter(item => item.item.child)
    }
  },

  /**
   * N tickets for the price of M tickets
   * tickets are sorted by their prices from cheapest to most expensive
   * cheaper tickets are discounted first
   * @param {number} n
   * @param {number} m
   */
  n4m (params) {
    Joi.assert(params, {
      n: Joi.number().integer().min(1).required(),
      m: Joi.number().integer().min(1).required()
    })
    assert(params.n > params.m)
    const {n, m} = params

    return (items, options) => {
      const setsOfN = Math.floor(items.length / n)
      const leftovers = items.length - n * setsOfN
      const count = setsOfN * (n - m) + Math.max(leftovers - m, 0)
      const sorted = _.sortBy(items, item => parseFloat(item.price))
      return sorted.slice(0, count)
    }
  },

  /**
   * Requires a minimum number of tickets to be bought
   */
  limitByMinTicketCount (params) {
    Joi.assert(params, {
      n: Joi.number().integer().min(1).required(),
    })
    const {n} = params

    return (items, options) => items.length >= n ? items : []
  },

  /**
   * For testing purpose
   * permits all ticket to pass through (i.e. discount applied for all tickets)
   */
  noLimit: function (params) {
    return (items, options) => {
      return items
    }
  }
}
