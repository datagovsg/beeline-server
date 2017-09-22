const Boom = require("boom")
const Joi = require("joi")

import * as events from '../events/events'
import {handleRequestWith} from '../util/endpoints'

export function register (server, options, next) {
  const m = server.plugins['sequelize'].models
  // Prompt update of promotions used upon completion of purchase
  events.on('newPurchase', {}, async (event) => {
    try {
      if (event.promotionId) {
        let promoInst = await m.Promotion.findById(event.promotionId)

        if (promoInst.params.usageLimit.globalLimit) {
          await m.PromoUsage.addGlobalPromoUsage(promoInst.id, event.numValidPromoTickets)
        }
      }
    } catch (err) {
      console.log(err)

      events.emit('transactionFailure', {
        message: `Error updating total usage of promotion (id: ${event.promoId}), with message: ${err.message}`
      })
    }
  })

  server.route({
    method: "GET",
    path: "/promotions/refCodeOwner",
    config: {
      tags: ["api"],
      description:
`Given a 6-digit alphanumeric referral code,
return the name and id of the referring user,
or 404 if not found`,
      validate: {
        query: {
          code: Joi.string().alphanum().required()
        }
      },
      auth: false
    },
    handler: handleRequestWith(
      request => m.Promotion.find({ where: {code: request.query.code} }),
      refCodeInst => refCodeInst && refCodeInst.params.ownerId
        ? m.User.findById(refCodeInst.params.ownerId) : undefined,
      userInst => userInst
        ? { name: userInst.name, referrerId: userInst.id }
        : Boom.notFound('Invalid Referral Code')
    )
  })

  next()
}
register.attributes = {
  name: "endpoint-promotions"
}
