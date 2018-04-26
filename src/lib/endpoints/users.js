const Joi = require("../util/joi")
const common = require("../util/common")
const Boom = require("boom")
import assert from "assert"
import jwt from "jsonwebtoken"
import * as auth from "../core/auth"
const emailModule = require("../util/email")
const sms = require("../util/sms")
const uuidv4 = require("uuid/v4")
import { InvalidArgumentError, NotFoundError } from "../util/errors"
import { handleRequestWith } from "../util/endpoints"

let { getModels, getDB, defaultErrorHandler } = common

export const register = function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/user",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
    },
    handler: async function(request, reply) {
      let m = common.getModels(request)

      let userInst = await m.User.findById(request.auth.credentials.userId)
      reply(userInst.toJSON())
    },
  })

  server.route({
    method: "GET",
    path: "/user/{userId}",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          userId: Joi.number()
            .integer()
            .min(0)
            .required(),
        },
      },
    },
    handler: async function(request, reply) {
      let m = common.getModels(request)

      try {
        let userInst = await m.User.findById(request.params.userId)
        NotFoundError.assert(userInst, "User not found")

        reply(userInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /** Send telephone verification.
  // FIXME: Proper rate limit
  **/
  server.route({
    method: "POST",
    path: "/users/sendTelephoneVerification",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        payload: {
          telephone: Joi.string()
            .telephone()
            .allow("+65########")
            .required(),
          alphanumericId: Joi.string()
            .default("BeelineSG")
            .valid(["GrabShuttle", "BeelineSG", "Beeline"]),
          appName: Joi.string()
            .default("Beeline")
            .max(20)
            .valid(["GrabShuttle", "Beeline"]),
        },
        query: Joi.object({
          dryRun: Joi.boolean().default(false),
        }).unknown(),
      },
      description:
        "Sends the telephone verification code to the phone number. Returns 400 if user not found.",
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        let userInst

        // Backdoor for iOS testers
        if (request.payload.telephone === "+65########") {
          [userInst] = await m.User.findCreateFind({
            defaults: { telephone: "+65########", status: "unverified" },
            where: { telephone: "+65########" },
          })

          userInst.telephoneCode = "000000"
          await userInst.save()
          return reply("")
        }

        [userInst] = await m.User.findCreateFind({
          defaults: {
            telephone: request.payload.telephone,
            status: "unverified",
          },
          where: { telephone: request.payload.telephone },
        })

        if (!userInst) {
          return reply(Boom.badRequest())
        }

        if (!request.payload.dryRun && !auth.ensureRateLimit(userInst)) {
          return reply(Boom.tooManyRequests())
        }

        let randomCode = auth.randomNDigits(6)
        userInst.telephoneCode = randomCode
        await userInst.save()

        if (!request.query.dryRun) {
          await sms.sendSMS({
            to: request.payload.telephone,
            from: request.payload.alphanumericId.replace(/\s/g, ""),
            body: `${randomCode} is your ${
              request.payload.appName
            } verification code`,
          })
        }

        reply("")
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(""))
      }
    },
  })

  /** Send email verification **/
  server.route({
    method: "POST",
    path: "/users/sendEmailVerification",
    config: {
      tags: ["api"],
      auth: { access: { scope: "user" } },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)
        let webDomain = process.env.WEB_DOMAIN
        let userInst = await m.User.findById(request.auth.credentials.userId)

        if (!userInst) {
          return reply(Boom.notFound())
        }

        if (!userInst.email) {
          return reply(
            Boom.badRequest("There is no email associated with your account")
          )
        }

        if (userInst.emailVerified) {
          return reply(Boom.badRequest("Your email has already been verified"))
        }

        // construct the token, valid for 3 days
        let token = encodeURIComponent(
          jwt.sign(
            {
              email: userInst.email,
              userId: userInst.id,
              action: "verifyEmail",
            },
            auth.emailVerificationKey,
            {
              expiresIn: "3d",
            }
          )
        )
        let url = `https://${webDomain}/users/verifyEmail?token=${token}`

        let message = `Dear ${userInst.name},

Please verify your email account. This will entitle you to benefits linked
to your email account.

${url}

Wishing you many happy rides ahead!

Regards,
Beeline Team
`
        let sendResult = await emailModule.sendMail({
          from: `admin@beeline.sg`,
          to: userInst.email,
          subject: "Beeline Email Verification",
          text: message,
        })
        reply(sendResult)
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(""))
      }
    },
  })

  /** Verify a user **/
  server.route({
    method: "GET",
    path: "/users/verifyEmail",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        query: Joi.object({
          token: Joi.string().required(),
        }),
      },
    },
    async handler(request, reply) {
      try {
        const data = jwt.verify(request.query.token, auth.emailVerificationKey)
        const m = common.getModels(request)

        assert.strictEqual(data["action"], "verifyEmail")

        Joi.assert(data["email"], Joi.string().email())
        Joi.assert(data["userId"], Joi.number().integer())

        const userInst = await m.User.find({
          where: {
            id: data.userId,
          },
        })
        assert(userInst, "User not found")

        InvalidArgumentError.assert.strictEqual(
          userInst.email,
          data.email,
          `The email associated with your account has been changed since ` +
            `you requested verification. Please request email verification again.`
        )

        InvalidArgumentError.assert(
          !userInst.emailVerified,
          `This email has already been verified`
        )

        await userInst.update({
          emailVerified: true,
        })

        reply.redirect("https://app.beeline.sg/#/tabs/settings")
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /** Verify a user **/
  server.route({
    method: "POST",
    path: "/users/verifyTelephone",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        payload: Joi.object({
          code: Joi.string().required(),
          telephone: Joi.string().required(),
        }),
      },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)

        assert(!!request.payload.telephone)
        assert(!!request.payload.code)

        let userInst = await m.User.find({
          where: {
            telephone: request.payload.telephone,
            telephoneCode: request.payload.code,
          },
        })

        if (userInst == null) {
          return reply(Boom.unauthorized())
        }
        if (Date.now() - userInst.updatedAt.getTime() > 30 * 60000) {
          return reply(Boom.unauthorized("Your verification code is expired"))
        }

        let loginTime = Date.now()

        await userInst.update({
          telephoneCode: null,
          status: "valid",
          lastLogin: loginTime,
        })

        userInst = await m.User.findById(userInst.id)

        reply({
          sessionToken: userInst.makeToken(loginTime),
          user: userInst.toJSON(),
        })
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(""))
      }
    },
  })

  /** Reset password **/
  server.route({
    method: "POST",
    path: "/users/resetPassword",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        payload: {
          token: Joi.string().required(),
          password: Joi.string().required(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let data = jwt.verify(request.payload.token, auth.emailVerificationKey)
        let m = common.getModels(request)
        let userInst = await m.User.find({
          where: {
            email: data.email,
          },
        })

        // already validated...
        if (userInst.status !== "valid") {
          return reply(Boom.notFound())
        }
        if (data.action !== "reset") {
          return reply(Boom.badRequest())
        }
        if (data.lastUpdated !== userInst.updatedAt.getTime()) {
          return reply(Boom.resourceGone())
        }

        // write changes
        userInst.password = request.payload.password
        await userInst.save()
        reply("")
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(""))
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/user",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      validate: {
        payload: Joi.object({
          email: Joi.string().email(),
          name: Joi.string(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        let userInst = await m.User.findById(request.auth.credentials.userId)

        await userInst.update(request.payload)
        reply(userInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/user/requestUpdateTelephone",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      validate: {
        payload: Joi.object({
          newTelephone: Joi.string()
            .telephone()
            .required(),
          dryRun: Joi.boolean().default(false),
        }),
      },
      response: {
        schema: Joi.object({
          updateToken: Joi.string().required(),
        }).unknown(),
      },
      description: `Replies with an 'update token', which when coupled with
the verification key sent to the new number, can be used to
update the phone.

To update (pseudo-code)
<pre>
1. result = post('requestUpdateTelephone', {newTelephone: '+6512345678'})
2. post('updateTelephone', {
  updateToken: result.updateToken,
  code: <6-DIGIT CODE RECEIVED VIA SMS>
})
</pre>
`,
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        assert(request.auth.credentials.userId)

        let randomCode = auth.randomNDigits()

        let userInst = await m.User.findById(request.auth.credentials.userId)
        userInst.telephoneCode = randomCode

        // Don't allow setting to itself
        if (request.payload.newTelephone === userInst.telephone) {
          return reply(Boom.badRequest("Telephone number has not changed"))
        }

        // Rate limit
        if (!request.payload.dryRun && !auth.ensureRateLimit(userInst)) {
          return reply(Boom.tooManyRequests())
        }
        await userInst.save()

        if (!request.payload.dryRun) {
          await sms.sendSMS({
            to: request.payload.newTelephone,
            from: sms.defaultFrom,
            body: `${randomCode} is your Beeline Verification Code`,
          })
        }

        reply({
          updateToken: auth.signVerification({
            userId: request.auth.credentials.userId,
            newTelephone: request.payload.newTelephone,
            action: "updateTelephone",
          }),
        })
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/user/updateTelephone",
    config: {
      tags: ["api"],
      description: `Updates a user's telephone number to the one
            given in the update token. If the new telephone number already
            exists in the database, the other user's telephone number is set
            to null and the user is assumed to be deactivated`,
      auth: { access: { scope: ["user"] } },
      validate: {
        payload: Joi.object({
          updateToken: Joi.string().required(),
          code: Joi.string().required(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        let updateRequest = auth.verifyVerification(
          request.payload.updateToken
        )

        if (
          updateRequest.action !== "updateTelephone" ||
          updateRequest.userId !== request.auth.credentials.userId
        ) {
          return reply(Boom.badRequest())
        }

        let m = getModels(request)
        let userInst = await m.User.findById(updateRequest.userId)

        // ensure that code is correct...
        if (
          userInst.get("telephoneCode", { raw: true }) !== request.payload.code
        ) {
          return reply(Boom.badRequest())
        }

        // Does a user exist who previously used that phone?
        let previousUser = await m.User.find({
          where: {
            telephone: updateRequest.newTelephone,
          },
        })
        if (previousUser != null && previousUser.id !== userInst.id) {
          // set the telephone to null, to avoid violating unique constraint
          previousUser.name = JSON.stringify({
            name: previousUser.name,
            telephone: previousUser.telephone,
          })
          previousUser.telephone = null
          await previousUser.save()
        }

        userInst.telephoneCode = null
        userInst.telephone = updateRequest.newTelephone
        await userInst.save()

        reply(userInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/users/auth/renew",
    config: {
      tags: ["api"],
      auth: { access: { scope: ["user"] } },
      description: `Renew a previously issued user token`,
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let userInst = await m.User.findById(request.auth.credentials.userId)

        return reply({
          sessionToken: userInst.makeToken(),
        })
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/users/search",
    config: {
      tags: ["api"],
      description: `Search for users. Mainly for admin view support`,
      validate: {
        query: Joi.object({
          q: Joi.string()
            .min(3)
            .optional()
            .allow(""),
          telephone: Joi.string()
            .optional()
            .allow(""),
          name: Joi.string()
            .optional()
            .allow(""),
          email: Joi.string()
            .optional()
            .allow(""),
          includeEphemeral: Joi.boolean()
            .default(false)
            .description("Include once-off users, e.g. WRS users"),
          limit: Joi.number()
            .integer()
            .max(20)
            .min(1),
        }).unknown(),
      },
      auth: { access: { scope: ["admin", "superadmin"] } },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let db = getDB(request)
        let where = {}

        if (!request.query.includeEphemeral) {
          where.telephone = { $not: null }
        }

        const escapeLike = function(s) {
          return s.replace(/[%_\\]/g, x => `\\${x}`)
        }
        const likeAround = function(s) {
          return `%${s}%`
        }

        // Name or telephone
        if (request.query.q) {
          where.$or = [
            { telephone: { $ilike: likeAround(escapeLike(request.query.q)) } },
            { name: { $ilike: likeAround(escapeLike(request.query.q)) } },
            { email: { $ilike: likeAround(escapeLike(request.query.q)) } },
          ]
        }

        if (request.query.telephone) {
          where.telephone = {
            $ilike: likeAround(escapeLike(request.query.telephone)),
          }
        }

        if (request.query.email) {
          where.email = { $ilike: likeAround(escapeLike(request.query.email)) }
        }

        if (request.query.name) {
          where.name = { $ilike: likeAround(escapeLike(request.query.name)) }
        }

        let searchQuery = {
          where,
          limit: request.query.limit,
          order: [
            [
              db.literal(
                '(SELECT MAX("createdAt") FROM "tickets" WHERE "tickets"."userId" = "user"."id")'
              ),
              "desc",
            ],
          ],
        }

        // If the user keys in the id directly, prioritize the user with the matching id
        let qFloat = parseFloat(request.query.q)
        if (isFinite(request.query.q) && qFloat === parseInt(qFloat)) {
          where.$or.splice(0, 0, { id: qFloat })
          searchQuery.order.splice(0, 0, [db.literal(`id <> ${qFloat}`)])
        }
        return reply(await m.User.findAll(searchQuery))
      } catch (error) {
        defaultErrorHandler(reply)(error)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/user/{userId}/telephoneCode",
    config: {
      tags: ["api"],
      description: `Retrieve user login pin, or generate one for user if it doesn't exist`,
      validate: {
        params: Joi.object({
          userId: Joi.number()
            .integer()
            .positive()
            .required(),
        }),
      },
      auth: { access: { scope: ["superadmin"] } },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let user = await m.User.findById(request.params.userId, {
          attributes: ["id", "telephoneCode"],
        })

        NotFoundError.assert(user, "User not found")

        if (!user.dataValues.telephoneCode) {
          let randomCode = auth.randomNDigits(6)
          await user.update({ telephoneCode: randomCode })
        }

        reply(user.dataValues.telephoneCode)
      } catch (error) {
        defaultErrorHandler(reply)(error)
      }
    },
  })

  /** Update the push notification tag **/
  server.route({
    method: "POST",
    path: "/user/push_notification_tag",
    config: {
      tags: ["api"],
      auth: { access: { scope: "user" } },
      description: `Generates a new push notification tag for this user.
        Devices that were previously subscribed to push notifications will
        **no longer** receive push notifications
      `,
    },
    handler: handleRequestWith(
      (i, request, { models }) =>
        models.User.findById(request.auth.credentials.userId),
      async userInst => {
        userInst.notes = {
          ...userInst.notes,
          pushNotificationTag: uuidv4(),
        }
        await userInst.save()

        return {
          tag: userInst.notes.pushNotificationTag,
        }
      }
    ),
  })

  next()
}
register.attributes = {
  name: "endpoint-users",
}
