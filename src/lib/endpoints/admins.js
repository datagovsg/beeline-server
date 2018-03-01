const _ = require("lodash")
const Joi = require("joi")
const { getModels, defaultErrorHandler } = require("../util/common")
const Boom = require("boom")
import assert from "assert"
import * as auth from "../core/auth"

/**
 * Registration function for the core Authentication/
 * Authorization functions.
 *
 * It provides a `bearer` authentication scheme and a `bearer`
 * authentication strategy.
 *
 * See HAPI docs for more info
 *
 * @param {*} server
 * @param {*} options
 * @param {*} next
 */
export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/companies/{companyId}/admins",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        params: {
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "view-admins",
          request.params.companyId
        )

        let admins = await m.Admin.findAll({
          include: [
            {
              model: m.TransportCompany,
              attributes: { exclude: ["logo"] },
              where: { id: request.params.companyId },
            },
          ],
        })

        reply(admins.map(a => a.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/admins/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "view-admins",
          request.params.companyId
        )

        let admin = await m.Admin.findOne({
          where: {
            id: request.params.id,
          },
          include: [
            {
              model: m.TransportCompany,
              where: { id: request.params.companyId },
            },
          ],
        })

        reply(admin ? admin.toJSON() : null)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/companies/{companyId}/admins",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        payload: Joi.object({
          name: Joi.string().optional(),
          email: Joi.string()
            .email()
            .required(),
          permissions: Joi.array().items(Joi.string()),
        }).unknown(),
        params: {
          companyId: Joi.number()
            .integer()
            .required(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-admins",
          request.params.companyId
        )

        // Create the admin...
        let company = await m.TransportCompany.findById(
          request.params.companyId
        )
        let [adminInst] = await m.Admin.findCreateFind({
          where: {
            email: request.payload.email.toLowerCase(),
          },
          defaults: {
            email: request.payload.email.toLowerCase(),
            name: request.payload.name,
          },
        })
        await company.addAdmin(adminInst, {
          name: request.payload.name,
          permissions: request.payload.permissions,
        })

        reply(adminInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/companies/{companyId}/admins/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        payload: {
          name: Joi.string().optional(),
          permissions: Joi.array().items(Joi.string()),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-admins",
          request.params.companyId
        )

        let adminInst = await m.Admin.findOne({
          where: { id: request.params.id },
          include: [
            {
              model: m.TransportCompany,
              where: { id: request.params.companyId },
            },
          ],
        })
        if (request.payload.permissions !== undefined) {
          adminInst.transportCompanies[0].adminCompany.set(
            "permissions",
            request.payload.permissions
          )
        }
        if (request.payload.name !== undefined) {
          adminInst.transportCompanies[0].adminCompany.set(
            "name",
            request.payload.name
          )
        }
        await adminInst.transportCompanies[0].adminCompany.save()

        reply(adminInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/admins/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      description: "Endpoint to allow admin to update his/her own name",
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        payload: {
          name: Joi.string(),
          email: Joi.string().email(),
          telephone: Joi.string()
            .allow(null)
            .allow(""),
          notes: Joi.object({
            telegramChatId: Joi.string(),
          })
            .unknown()
            .allow(null),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let adminInst = await m.Admin.findById(
          request.auth.credentials.adminId
        )

        assert.strictEqual(adminInst.id, request.params.id)

        const { name, email, telephone, notes } = request.payload
        await adminInst.update({
          name,
          telephone,
          notes,
          email: email.toLowerCase(),
        })

        reply(adminInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/admins/whoami",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      description: "Checks if the login is valid/invalid",
    },
    handler(request, reply) {
      reply(
        _.pick(request.auth.credentials, [
          "scope",
          "email",
          "adminId",
          "transportCompanyIds",
          "permissions",
        ])
      )
    },
  })

  server.route({
    method: "POST",
    path: "/admins",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["superadmin"] },
      },
      description: "Endpoint to allow superadmin to subscribe to notifications",
      validate: {
        payload: {
          name: Joi.string(),
          telephone: Joi.string()
            .allow(null)
            .allow(""),
          notes: Joi.object({
            telegramChatId: Joi.string(),
          })
            .unknown()
            .allow(null),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let adminInst = await m.Admin.findCreateFind({
          where: { email: request.auth.credentials.email.toLowerCase() },
          defaults: _.assign({}, request.payload, {
            email: request.auth.credentials.email,
          }),
        })

        reply(adminInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })
  server.route({
    method: "GET",
    path: "/admins/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      description: "Endpoint to allow admin to update his/her own name",
      validate: {
        params: { id: Joi.number().integer() },
      },
    },
    async handler(request, reply) {
      try {
        // TODO: probably the only place where we don't use auth.* functions
        // for authorization
        assert(
          (request.auth.credentials.scope === "admin" &&
            request.params.id === request.auth.credentials.adminId) ||
            request.auth.credentials.scope === "superadmin"
        )
        let m = getModels(request)
        let adminInst = await m.Admin.findById(
          request.auth.credentials.adminId,
          {
            include: [
              { model: m.TransportCompany, attributes: { exclude: ["logo"] } },
            ],
          }
        )

        reply(adminInst.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "DELETE",
    path: "/companies/{companyId}/admins/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      validate: {
        params: {
          companyId: Joi.number()
            .integer()
            .required(),
          id: Joi.number()
            .integer()
            .required(),
        },
      },
      description:
        "Sends the telephone verification code to the phone number. Returns 400 if user not found.",
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-admins",
          request.params.companyId
        )

        await (await m.TransportCompany.findById(
          request.params.companyId
        )).removeAdmin(request.params.id)

        reply("")
      } catch (err) {
        console.error(err.stack)
        reply(Boom.badImplementation(""))
      }
    },
  })
  next()
}

register.attributes = {
  name: "endpoint-admins",
}
