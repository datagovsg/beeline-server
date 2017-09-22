const _ = require("lodash")
const Joi = require("joi")
const toSVY = require("../util/svy21").toSVY
const toWGS = require("../util/svy21").toWGS
const common = require("../util/common")
const Boom = require("boom")
import assert from "assert"
import qs from "querystring"
import jwt from "jsonwebtoken"
import * as auth from "../core/auth"
const {send: sendEmail} = require("../util/email")
const sms = require("../util/sms")
import * as events from '../events/events'
import { TransactionBuilder } from '../transactions/builder'
import {TransactionError} from "../util/errors"

var {getModels, getDB, defaultErrorHandler} = common

/**
**/
export function register (server, options, next) {
  // Event triggers when user makes a purchase (per ticket)
  // If the user is not yet assigned a referrerId, assign his own id to it
  // If the user has a referrerId, check if referral rewards have been paid out
  // Payout referral rewards to referrer if that is not yet done
  // Clean up redundant data left behind in notes
  events.on('newPurchase', {}, async (event) => {
    var m = server.plugins['sequelize'].models
    var db = server.plugins['sequelize'].db

    const userId = event.userId
    const referrerReward = process.env.REFERRAL_REFERER_REWARD || '0.00'

    try {
      await db.transaction({
        isolationLevel: db.Transaction.ISOLATION_LEVELS.SERIALIZABLE
      }, async (transaction) => {
        var userInst = await m.User.findById(userId, {transaction})

        if (userInst.referrerId) {
          if (userInst.notes && userInst.notes.pendingPayoutToReferrer) {
            assert(userInst.referrerId !== userInst.id)

            let referrerInst = await m.User.findById(userInst.referrerId, {transaction})

            TransactionError.assert(referrerInst, "Unable to payout: Referrer does not exist")

            // Payout benefits to referrer
            // Clean up referrals data in notes

            const cogsAccount = await m.Account.getByName("Cost of Goods Sold", { transaction })
            const from = { itemType: 'account', itemId: cogsAccount.id }
            const to = { itemType: 'userCredit', itemId: referrerInst.id }
            const description = `Referrer Payout:  Referrer's (id: ${referrerInst.id}) referee (id: ${userInst.id}) completed first purchase.`

            let tb = new TransactionBuilder({
              db, transaction,
              models: m,
              dryRun: false,
              committed: true,
              creator: {
                type: 'system',
              },

            })

            tb.description = description

            tb = await m.Credit.moveCredits(from, to, referrerReward, tb)

            await tb.build({type: 'referralRewards'})

            userInst.notes = _.omit(userInst.notes, ['pendingPayoutToReferrer'])
            await userInst.save({ transaction })
            return true
          } else {
            // entered when already paid out
            return false
          }
        } else {
          // entered when user was not referred by anyone
          userInst.referrerId = userId
          await userInst.save({ transaction })

          return false
        }
      }).then(async function (isPaidOut) {
        if (!isPaidOut) return

        let userInst = await m.User.findById(userId)
        let referrerInst = await m.User.findById(userInst.referrerId)

        // notify referrer of payout
        await sms.sendSMS({
          to: referrerInst.telephone,
          from: sms.defaultFrom,
          body: `Congratulations! You have received $${referrerReward} for successfully referring ${userInst.name} to Beeline!`,
        })
      })
    } catch (err) {
      console.log(err)

      events.emit('transactionFailure', {
        message: `Error in process of distributing benefits to referrer after successful purchase by referee (id: ${userId}), with message: ${err.message}`,
        userId
      })
    }
  })

  // Retrieve user's own referral code, create it in the promotion table if it does not exist
  // Requires user to be logged in
  // RETURN: String - referralCode
  server.route({
    method: "GET",
    path: "/user/referralCode",
    config: {
      tags: ["api"],
      description: "Get Referral Code",
      auth: {access: {scope: ['user']}},
      validate: {}
    },
    handler: async function (request, reply) {
      try {
        // get instance for logged in user
        var m = common.getModels(request)

        var userInst = await m.User.findById(request.auth.credentials.userId)
        var refCodeInst

        // if user currently doesn't have a refCode assigned, create it
        if (!userInst.refCodeId) {
          refCodeInst = await userInst.generateRefCode()
        } else {
          refCodeInst = await m.Promotion.findById(userInst.refCodeId)
        }

        reply(refCodeInst.code)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  // Retrieve user's saved referral codes,
  // Requires user to be logged in
  // RETURN: Obj with all saved refCodes {refCode : refCodeOwner}
  // server.route({
  //   method: "GET",
  //   path: "/user/savedReferralCodes",
  //   config: {
  //     tags: ["api"],
  //     description: "Get Referral Code",
  //     auth: {access: {scope: ['user']}},
  //     validate: {}
  //   },
  //   handler: async function(request, reply){
  //     try {
  //       // get instance for logged in user
  //       var m = common.getModels(request);

  //       var userInst = await m.User.findById(request.auth.credentials.userId);

  //       if(await userInst.isEligibleForReferralProgram()){
  //         reply(userInst.getSavedRefCode())
  //       } else {
  //         throw new TransactionError("Sorry, you are not eligible to use referral codes")
  //       }

  //     } catch (err) {
  //       defaultErrorHandler(reply)(err);
  //     }

  //   }
  // });

  // Endpoint called when user keys in a referral code to be used
  // during a purchase, or when a user registers via a referral
  // Data payload contents:
  // - refCode - String: referral code
  // - refCodeOwner - Obj: {name, referrerId}
  // server.route({
  //   method: "PUT",
  //   path: "/user/referralCode",
  //   config: {
  //     tags: ["api"],
  //     description: "Save a Referral Code to be used by User",
  //     auth: {access: {scope: ['user']}},
  //     validate: {
  //       payload: {
  //         refCodeOwner: Joi.object({
  //           name: Joi.string(),
  //           referrerId: Joi.number().required(),
  //         }),
  //         refCode: Joi.string().required(),
  //       }
  //     }
  //   },
  //   async handler(request, reply){
  //     try {
  //       // get instance for logged in user
  //       var m = common.getModels(request);

  //       var userInst = await m.User.findById(request.auth.credentials.userId);

  //       if(!userInst.referrerId){
  //         await userInst.saveRefCode(request.payload.refCode, request.payload.refCodeOwner)
  //         reply(userInst.getSavedRefCode())
  //       } else {
  //         throw new TransactionError("Sorry, you are not eligible to use referral codes")
  //       }

  //     } catch (err) {
  //       defaultErrorHandler(reply)(err);
  //     }

  //   }
  // });


  // Endpoint called to distribute credits to user on applying Referral Code
  // pre-purchase, or on creating an account via a referral link.
  // Also sets up referrer to be given rewards when current user successfully
  // completes a purchase.
  // Amount given is defined here.
  // Data payload contents:
  // - refCode: string
  server.route({
    method: "POST",
    path: "/user/applyRefCode",
    config: {
      tags: ['api'],
      description: "Distribute referral code benefits to new user",
      auth: {access: {scope: ['user']}},
      validate: {
        payload: {
          refCode: Joi.string().required()
        },
      }
    },
    async handler (request, reply) {
      const newUserReward = process.env.REFERRAL_REFEREE_REWARD || '0.00'

      try {
        var db = common.getDB(request)
        var m = common.getModels(request)
        var userInst = await m.User.findById(request.auth.credentials.userId)
        var refCodeInst = await m.Promotion.findOne({ where: { code: request.payload.refCode }})

        if (!refCodeInst) {
          // Should not ever reach here since a check is done on the ui side
          // for the validity of the refCode
          throw new TransactionError("The Referral Code given is invalid")
        }

        var refCodeOwner = await m.User.findById(refCodeInst.params.ownerId)

        await db.transaction({
          isolationLevel: db.Transaction.ISOLATION_LEVELS.SERIALIZABLE
        }, async (transaction) => {
          if ((await userInst.isEligibleForReferralProgram()) && refCodeOwner) {
            const cogsAccount = await m.Account.getByName("Cost of Goods Sold", { transaction })

            // Give the new User credits

            const from = { itemType: 'account', itemId: cogsAccount.id }
            const to = { itemType: 'referralCredits', itemId: userInst.id }
            const description = `Referee Payout:  New User (id: ${userInst.id}) joined via Referrer (id: ${refCodeOwner.id})`

            let tb = new TransactionBuilder({
              db, transaction,
              models: m,
              dryRun: false,
              committed: true,
              creator: {
                type: 'system',
              },
            })

            tb.description = description

            tb = await m.ReferralCredit.moveCredits(from, to, newUserReward, tb)

            await tb.build({type: 'referralRewards'})

            userInst.notes = userInst.notes || {}
            userInst.notes.pendingPayoutToReferrer = true

            userInst.referrerId = refCodeOwner.id

            await userInst.save({transaction})
          } else {
            throw new TransactionError("Sorry, you are not eligible to use referral codes")
          }
        })

        reply()
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/user/referralCredits",
    config: {
      tags: ["api"],
      description: "Get User's Referral Credits",
      auth: {access: {scope: ['user']}},
      validate: {}
    },
    handler: async function (request, reply) {
      try {
        // get instance for logged in user
        var m = common.getModels(request)

        let credits = await m.ReferralCredit.getReferralCredits(request.auth.credentials.userId)

        reply(credits)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}
register.attributes = {
  name: "endpoint-userReferrals"
}
