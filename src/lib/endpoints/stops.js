const Joi = require("joi")

const {
  handleRequestWith,
  authorizeByRole,
  instToJSONOrNotFound,
  deleteInst,
} = require("../util/endpoints")

export function register(server, options, next) {
  if (!server.plugins["sequelize"]) {
    throw new Error("Sequelize has to be initialized first!")
  }
  const { models: m } = server.plugins["sequelize"]

  const authorize = authorizeByRole("manage-routes", () => undefined)
  const findById = request => m.Stop.findById(request.params.id)

  server.route({
    method: "GET",
    path: "/stops",
    config: {
      auth: false,
      tags: ["api", "admin", "commuter"],
    },
    handler: handleRequestWith(
      () => m.Stop.findAll(),
      stops => stops.map(s => s.toJSON())
    ),
  })

  server.route({
    method: "GET",
    path: "/stops/{id}",
    config: {
      tags: ["api", "admin", "commuter"],
      auth: false,
      validate: {
        params: {
          id: Joi.number(),
        },
      },
    },
    handler: handleRequestWith(findById, instToJSONOrNotFound),
  })

  server.route({
    method: "POST",
    path: "/stops",
    config: {
      tags: ["api"],
      auth: {
        access: {
          scope: ["superadmin"],
        },
      },
      validate: {},
    },
    handler: handleRequestWith(authorize, request => {
      delete request.payload.id
      return m.Stop.create(request.payload).then(s => s.toJSON())
    }),
  })

  server.route({
    method: "PUT",
    path: "/stops/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: {
          scope: ["superadmin"],
        },
      },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    handler: handleRequestWith(
      authorize,
      findById,
      async (stopInst, request) => {
        if (stopInst) {
          delete request.payload.id
          await stopInst.update(request.payload)
        }
        return stopInst
      },
      instToJSONOrNotFound
    ),
  })

  server.route({
    method: "DELETE",
    path: "/stops/{id}",
    config: {
      tags: ["api"],
      auth: {
        access: { scope: ["superadmin"] },
      },
      validate: {
        params: {
          id: Joi.number(),
        },
      },
    },
    handler: handleRequestWith(authorize, findById, deleteInst),
  })
  next()
}
register.attributes = {
  name: "endpoint-stops",
}
