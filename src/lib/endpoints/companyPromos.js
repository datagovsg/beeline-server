let _ = require("lodash")
let Joi = require("joi")
let Boom = require("boom")

import { InvalidArgumentError } from "../util/errors"
import {
  discountingFunctions,
  refundingFunctions,
} from "../promotions/functions/discountRefunds"
import {
  handleRequestWith,
  authorizeByRole,
  deleteInst,
} from "../util/endpoints"

import { qualifiers } from "../promotions"

export function register(server, options, next) {
  if (!server.plugins["sequelize"]) {
    throw new Error("Sequelize has to be initialized first!")
  }
  const { db, models: m } = server.plugins["sequelize"]

  const authorize = authorizeByRole("manage-company")
  const findByPromoId = async request => {
    const id = request.params.id
    const promoId = request.params.promoId
    const promoCodeInst = await m.Promotion.findById(promoId)
    if (promoCodeInst) {
      InvalidArgumentError.assert(
        promoCodeInst.params && id === +promoCodeInst.params.companyId,
        "Promo code " + promoId + " does not belong to company " + id
      )
    }
    return promoCodeInst
  }

  const withUsageCounts = async (m, db, promos) => {
    const promoIds = promos.map(p => p.id)
    const usageCounts = await db
      .query(
        `
      select "promoId",
      sum(case when "userId" is null then "count" end) as global,
      count(case when "userId" is not null then 1 end) as "distinctUsers"
      from "promoUsages"
      where "promoId" = ANY(ARRAY[:promoIds]::int[])
      and count > 0
      group by "promoId"
    `,
        { replacements: { promoIds } }
      )
      .then(r => {
        const [result] = r
        const promoUsages = result.map(counts => {
          counts.global = +counts.global
          counts.distinctUsers = +counts.distinctUsers
          return counts
        })
        return _.keyBy(promoUsages, "promoId")
      })

    return promos.map(p =>
      _.assign({}, p, { counts: _.omit(usageCounts[p.id], "promoId") })
    )
  }

  server.route({
    method: "GET",
    path: "/companies/{id}/promotions",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      authorize,
      request =>
        m.Promotion.findAll({
          where: { "params.companyId": request.params.id },
        }),
      promos => withUsageCounts(m, db, promos.map(p => p.toJSON()))
    ),
  })

  server.route({
    method: "GET",
    path: "/companies/{id}/promotions/{promoId}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          promoId: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      authorize,
      findByPromoId,
      async promoCodeInst =>
        promoCodeInst
          ? (await withUsageCounts(m, db, [promoCodeInst.toJSON()]))[0]
          : Boom.notFound()
    ),
  })

  const assertLimitByCompany = (qualifyingCriteria, id) => {
    InvalidArgumentError.assert(
      _.some(qualifyingCriteria, {
        type: "limitByCompany",
        params: { companyId: id },
      }),
      "Use of this promo code must be limited to this company"
    )
  }

  const validateQualifyingCriteria = (promoType, qualifyingCriteria) => {
    const qualifiersByType = qualifiers[promoType]
    InvalidArgumentError.assert(
      qualifiersByType,
      `Unrecognised Promo Type ${promoType}`
    )
    for (let criteria of qualifyingCriteria) {
      InvalidArgumentError.assert(
        qualifiersByType.qualifyingFunctions[criteria.type] !== undefined,
        "Qualifying criteria not recognised: " + criteria.type
      )
      qualifiersByType.qualifyingFunctions[criteria.type](criteria.params)
    }
  }

  const validateDiscountFunction = discountFunction => {
    InvalidArgumentError.assert(
      discountingFunctions[discountFunction.type] !== undefined,
      "Discount function not recognised: " + discountFunction.type
    )
    discountingFunctions[discountFunction.type](discountFunction.params)
  }

  const validateRefundFunction = refundFunction => {
    InvalidArgumentError.assert(
      refundingFunctions[refundFunction.type] !== undefined,
      "Refund function not recognised: " + refundFunction.type
    )
  }

  server.route({
    method: "PUT",
    path: "/companies/{id}/promotions/{promoId}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          promoId: Joi.number().integer(),
        },
        payload: {
          code: Joi.string().allow(""),
          type: Joi.string(),
          description: Joi.string(),

          params: Joi.object()
            .keys({
              tag: Joi.string()
                .allow("")
                .allow(null),

              creditAmt: Joi.number()
                .min(0)
                .precision(2),

              qualifyingCriteria: Joi.array().items(
                Joi.object().keys({
                  type: Joi.string().required(),
                  params: Joi.object().required(),
                })
              ),

              discountFunction: Joi.object()
                .keys({
                  type: Joi.string().required(),
                  params: Joi.object().required(),
                })
                .allow(null),
              refundFunction: Joi.object()
                .keys({
                  type: Joi.string().required(),
                  params: Joi.object().required(),
                })
                .allow(null),
              usageLimit: Joi.object().keys({
                userLimit: Joi.number()
                  .integer()
                  .min(0)
                  .allow(null),
                globalLimit: Joi.number()
                  .integer()
                  .min(0)
                  .allow(null),
              }),
            })
            .unknown(false),
        },
      },
    },
    handler: handleRequestWith(
      authorize,
      findByPromoId,
      async (promoCodeInst, request) => {
        const id = request.params.id

        if (request.payload.params) {
          if (request.payload.params.qualifyingCriteria !== undefined) {
            assertLimitByCompany(request.payload.params.qualifyingCriteria, id)
            validateQualifyingCriteria(
              request.payload.type,
              request.payload.params.qualifyingCriteria
            )
          }

          if (request.payload.params.discountFunction !== undefined) {
            validateDiscountFunction(request.payload.params.discountFunction)
          }

          if (request.payload.params.refundFunction !== undefined) {
            validateRefundFunction(request.payload.params.refundFunction)
          }

          const newParams = _.assign(
            {},
            promoCodeInst.params,
            request.payload.params
          )
          // throw out the qualifying criteria returned by lodash merge,
          // and create it by assignment
          newParams.qualifyingCriteria =
            request.payload.params.qualifyingCriteria ||
            promoCodeInst.qualifyingCriteria
          request.payload.params = newParams
        }

        await promoCodeInst.update(request.payload)
        return promoCodeInst.toJSON()
      }
    ),
  })

  server.route({
    method: "POST",
    path: "/companies/{id}/promotions",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        payload: {
          code: Joi.string()
            .required()
            .allow(""),
          type: Joi.string().required(),
          description: Joi.string(),

          params: Joi.object()
            .keys({
              tag: Joi.string(),

              creditAmt: Joi.number()
                .min(0)
                .precision(2),

              qualifyingCriteria: Joi.array()
                .items(
                  Joi.object().keys({
                    type: Joi.string().required(),
                    params: Joi.object().required(),
                  })
                )
                .required(),

              discountFunction: Joi.object()
                .keys({
                  type: Joi.string().required(),
                  params: Joi.object().required(),
                })
                .required(),
              refundFunction: Joi.object()
                .keys({
                  type: Joi.string().required(),
                  params: Joi.object().required(),
                })
                .required(),
              usageLimit: Joi.object().keys({
                userLimit: Joi.number()
                  .integer()
                  .min(0)
                  .allow(null),
                globalLimit: Joi.number()
                  .integer()
                  .min(0)
                  .allow(null),
              }),
            })
            .unknown(false)
            .required(),
        },
      },
    },
    handler: handleRequestWith(authorize, async request => {
      const id = request.params.id

      request.payload.params.companyId = id
      assertLimitByCompany(request.payload.params.qualifyingCriteria, id)
      validateQualifyingCriteria(
        request.payload.type,
        request.payload.params.qualifyingCriteria
      )
      validateDiscountFunction(request.payload.params.discountFunction)
      validateRefundFunction(request.payload.params.refundFunction)

      const promoCodeInst = await m.Promotion.create(request.payload)
      return promoCodeInst.toJSON()
    }),
  })

  server.route({
    method: "DELETE",
    path: "/companies/{id}/promotions/{promoId}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
          promoId: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(authorize, findByPromoId, deleteInst),
  })
  next()
}
register.attributes = {
  name: "endpoint-company-promos",
}
