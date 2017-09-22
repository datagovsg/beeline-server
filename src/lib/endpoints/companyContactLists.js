import {InvalidArgumentError} from "../util/errors"
import {authorizeByRole, handleRequestWith, instToJSONOrNotFound, deleteInst} from "../util/endpoints"
import {getModels} from "../util/common"
const Joi = require("../util/joi")

export function register (server, options, next) {
  const authorize = authorizeByRole('manage-customers')

  const findContactListById = async (request) => {
    const m = getModels(request)
    const id = request.params.id
    const listId = request.params.listId

    const contactListInst = await m.ContactList.findById(listId)

    if (contactListInst) {
      InvalidArgumentError.assert(
        id === +contactListInst.transportCompanyId,
        'Telephone list ' + listId + ' does not belong to company ' + id
      )
    }

    return contactListInst
  }

  const findAllLists = request => {
    const m = getModels(request)
    return m.ContactList.findAll({
      where: { transportCompanyId: request.params.id },
      attributes: { exclude: ['telephones', 'emails'] },
    })
  }

  server.route({
    method: "GET",
    path: "/companies/{id}/contactLists",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer()
        }
      },
    },
    handler: handleRequestWith(authorize, findAllLists, contactLists => contactLists.map(l => l.toJSON()))
  })

  server.route({
    method: "GET",
    path: "/companies/{id}/contactLists/{listId}",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer(),
          listId: Joi.number().integer(),
        }
      },
    },
    handler: handleRequestWith(authorize, findContactListById, instToJSONOrNotFound)
  })

  server.route({
    method: "PUT",
    path: "/companies/{id}/contactLists/{listId}",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer(),
          listId: Joi.number().integer(),
        },
        payload: {
          description: Joi.string(),
          telephones: Joi.array().items(Joi.string().telephone()),
          emails: Joi.array().items(Joi.string().email()),
        }
      },
    },
    handler: handleRequestWith(
      authorize,
      findContactListById,
      (list, request) => {
        return list.update(request.payload).then(list => list.toJSON())
      }
    )
  })

  server.route({
    method: "DELETE",
    path: "/companies/{id}/contactLists/{listId}",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer(),
          listId: Joi.number().integer(),
        }
      },
    },
    handler: handleRequestWith(authorize, findContactListById, deleteInst)
  })

  server.route({
    method: "POST",
    path: "/companies/{id}/contactLists",
    config: {
      tags: ["api"],
      auth: {access: {scope: ['admin', 'superadmin']}},
      validate: {
        params: {
          id: Joi.number().integer(),
          listId: Joi.number().integer(),
        },
        payload: {
          description: Joi.string(),
          telephones: Joi.array().items(Joi.string().telephone()),
          emails: Joi.array().items(Joi.string().email())
        }
      },
    },
    handler:
      handleRequestWith(authorize, request => {
        const m = getModels(request)
        request.payload.transportCompanyId = request.params.id
        return m.ContactList.create(request.payload)
                              .then(list => list.toJSON())
      }),
  })

  next()
}
register.attributes = {
  name: "endpoint-company-telephone-lists"
}
