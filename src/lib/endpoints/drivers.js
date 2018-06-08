const _ = require("lodash")
const Joi = require("../util/joi")
const { getModels, defaultErrorHandler } = require("../util/common")
const Boom = require("boom")
const sms = require("../util/sms")
import assert from "assert"
import leftPad from "left-pad"
import * as auth from "../core/auth"

export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/companies/{companyId}/drivers/{id}",
    config: {
      auth: { access: { scope: ["driver", "superadmin", "admin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
      tags: ["api", "admin", "driver"],
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "view-drivers",
          request.payload.transportCompanyId
        )

        let driverInstance = await m.Driver.find({
          where: { id: request.params.id },
          include: [
            {
              model: m.TransportCompany,
              where: { id: request.params.companyId },
            },
            {
              model: m.Vehicle,
              attributes: { exclude: ["photo"] },
            },
          ],
        })

        reply(driverInstance.toJSON())
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{companyId}/drivers",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
      tags: ["api", "admin"],
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "view-drivers",
          request.params.companyId
        )

        let drivers = await m.Driver.findAll({
          include: [
            {
              model: m.TransportCompany,
              where: { id: request.params.companyId },
              attributes: { exclude: ["terms", "features", "logo"] },
            },
            {
              model: m.Vehicle,
              attributes: { exclude: ["photo"] },
            },
          ],
        })

        reply(drivers.map(d => d.toJSON()))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/drivers",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        query: {
          driverIds: Joi.array().items(Joi.number().integer()),
          telephones: Joi.array().items(Joi.string()),
        },
      },
      description:
        "Allow admin to search/query drivers by telephone/ids. To facilitate adminview",
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        let companyIds = await auth.getCompaniesByRole(
          request.auth.credentials,
          "view-drivers"
        )

        let query = {
          include: [
            {
              model: m.TransportCompany,
              where: { id: { $in: companyIds } },
            },
            {
              model: m.Vehicle,
              attributes: { exclude: ["photo"] },
            },
          ],
        }
        if (request.query.telephones && request.query.telephones.length > 0) {
          _.set(query, "where.telephone", { $in: request.query.telephones })
        }
        if (request.query.driverIds && request.query.driverIds.length > 0) {
          _.set(query, "where.id", { $in: request.query.driverIds })
        }
        let drivers = await m.Driver.findAll()

        return reply(drivers.map(d => d.toJSON()))
      } catch (err) {
        console.error(err.stack)
        return reply(Boom.badImplementation())
      }
    },
  })

  /** Create a new driver **/
  server.route({
    method: "POST",
    path: "/drivers",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        payload: Joi.object({
          name: Joi.string(),
          telephone: Joi.string().telephone(),
          transportCompanyId: Joi.number()
            .integer()
            .optional(),
        }),
      },
      tags: ["api", "deprecated"],
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-drivers",
          request.payload.transportCompanyId
        )

        // add the company to the driver
        let [driverInstance] = await m.Driver.findCreateFind({
          where: {
            telephone: request.payload.telephone,
          },
          defaults: {
            name: request.payload.name,
            telephone: request.payload.telephone,
          },
        })

        await driverInstance.addTransportCompany(
          request.payload.transportCompanyId,
          {
            name: request.payload.name,
          }
        )

        reply(driverInstance.toJSON())
      } catch (err) {
        console.log(err)
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/companies/{companyId}/drivers",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        payload: Joi.object({
          name: Joi.string(),
          telephone: Joi.string().telephone(),
          remarks: Joi.string()
            .default("")
            .allow(""),
        }),
        params: {
          companyId: Joi.number().integer(),
        },
      },
      tags: ["api", "admin"],
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-drivers",
          request.params.companyId
        )

        // add the company to the driver
        let [driverInstance] = await m.Driver.findCreateFind({
          where: {
            telephone: request.payload.telephone,
          },
          defaults: {
            name: request.payload.name,
            telephone: request.payload.telephone,
          },
        })

        await driverInstance.addTransportCompany(request.params.companyId, {
          name: request.payload.name,
          remarks: request.payload.remarks,
        })

        reply(driverInstance.toJSON())
      } catch (err) {
        console.log(err)
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /* Update the driver name */
  server.route({
    method: "PUT",
    path: "/drivers/{id}",
    config: {
      tags: ["api", "driver"],
      auth: { access: { scope: ["driver", "superadmin"] } },
      validate: {
        payload: Joi.object({
          name: Joi.string(),
          transportCompanyId: Joi.number()
            .integer()
            .optional(),
        }),
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        if (request.auth.credentials.scope === "driver") {
          assert.strictEqual(
            request.params.id,
            request.auth.credentials.driverId
          )
        }
        await m.Driver.update(
          {
            name: request.payload.name,
          },
          {
            where: {
              id: request.params.id,
            },
          }
        )

        let driverInstance = await m.Driver.findById(request.params.id, {
          include: [m.TransportCompany],
        })
        reply(driverInstance.toJSON())
      } catch (error) {
        defaultErrorHandler(reply)(error)
      }
    },
  })

  /* Update driver name on the **association** */
  server.route({
    method: "PUT",
    path: "/companies/{companyId}/drivers/{driverId}",
    config: {
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        payload: Joi.object({
          name: Joi.string(),
          remarks: Joi.string()
            .default("")
            .allow(""),
        }),
        params: {
          companyId: Joi.number().integer(),
          driverId: Joi.number().integer(),
        },
      },
      tags: ["api", "admin"],
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)
        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-drivers",
          request.params.companyId
        )

        // validate telephone numberes
        // request.payload.telephone = Valid.telephone(request.payload.telephone);

        let driverInstance = await m.Driver.findOne({
          where: { id: request.params.driverId },
          include: [
            {
              model: m.TransportCompany,
              where: { id: request.params.companyId },
            },
          ],
        })

        let updatedInfo = { name: request.payload.name }
        if (request.payload.remarks) {
          updatedInfo.remarks = request.payload.remarks
        }

        await driverInstance.transportCompanies[0].driverCompany.update(
          updatedInfo
        )

        reply(driverInstance.toJSON())
      } catch (err) {
        console.log(err)
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /* Delete */
  server.route({
    method: "DELETE",
    path: "/companies/{companyId}/drivers/{driverId}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["superadmin", "admin"] } },
      validate: {
        params: {
          driverId: Joi.number().integer(),
          companyId: Joi.number().integer(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-drivers",
          request.params.companyId
        )

        let driverInst = await m.Driver.findById(request.params.driverId)
        await driverInst.removeTransportCompany(request.params.companyId)

        reply(driverInst)
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /** Send telephone verification.
   **/
  server.route({
    method: "POST",
    path: "/drivers/sendTelephoneVerification",
    config: {
      tags: ["api", "admin"],
      auth: false,
      validate: {
        payload: {
          telephone: Joi.string()
            .telephone()
            .allow("+65########")
            .required(),
        },
        query: {
          dryRun: Joi.boolean().default(false),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)

        // Backdoor for iOS testers
        if (request.payload.telephone === "+65########") {
          await m.Driver.update(
            {
              pairingCode: "000000",
            },
            {
              where: {
                telephone: "+65########",
              },
            }
          )
          return reply("")
        }

        let findDriverWhere = {
          telephone: request.payload.telephone,
        }
        let driverInst = await m.Driver.find({
          where: findDriverWhere,
          include: [
            /* Required: true ensures that the driver belongs
             to at least one company */
            { model: m.TransportCompany, required: true },
          ],
        })

        if (!driverInst) {
          return reply(Boom.notFound())
        }

        if (!request.payload.dryRun && !auth.ensureRateLimit(driverInst)) {
          return reply(Boom.tooManyRequests())
        }

        let randomCode = leftPad(Math.floor(Math.random() * 1000000), 6, 0)
        driverInst.pairingCode = randomCode
        await driverInst.save()

        if (!request.query.dryRun) {
          await sms.sendSMS({
            to: request.payload.telephone,
            from: "BeelinDrvr",
            body: `DRIVER: ${randomCode} is your Beeline verification code`,
          })
        }

        reply("")
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/drivers/verifyTelephone",
    config: {
      tags: ["api", "admin"],
      auth: false,
      validate: {
        payload: Joi.object({
          telephone: Joi.string(),
          code: Joi.string(),
        }),
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let driverInst = await m.Driver.find({
          where: {
            telephone: request.payload.telephone,
            pairingCode: request.payload.code,
          },
          include: [
            {
              model: m.TransportCompany,
            },
          ],
        })

        if (!driverInst) {
          return reply(Boom.unauthorized())
        }

        await driverInst.update({
          pairingCode: null,
        })

        reply({
          sessionToken: driverInst.makeToken(),
          driver: driverInst.toJSON(),
        })
      } catch (err) {
        console.error(err)
        reply(Boom.badImplementation())
      }
    },
  })

  server.route({
    method: "POST",
    path: "/drivers/auth/renew",
    config: {
      tags: ["api", "driver"],
      auth: { access: { scope: ["driver"] } },
      description: `Renew a previously issued driver token`,
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let driverInst = await m.Driver.findById(
          request.auth.credentials.driverId
        )

        return reply({
          sessionToken: driverInst.makeToken(),
        })
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })
  next()
}
register.attributes = {
  name: "endpoint-drivers",
}
