const Boom = require("boom")
const _ = require("lodash")

const {NotFoundError, defaultErrorHandler, getDB, getModels} = require("../util/common")
const auth = require("../core/auth")

/**
 * Routes requests to a HAPI server to the specified
 * HAPI route configuration object over multiple RESTful paths
 * @param {Server} server - a HAPI server object
 * @param {Object} config - a route configuration object
 * @param {...(string|object)} paths - one or more strings or
 * partial route configuration objects which contains at least
 * a path field that would be merged into a copy of config
 * @example
 *   routeRequestsTo(server, ['/path1', '/path2'], {
 *     method: "GET",
 *     config: { ... },
 *     handler: ...
 *   });
 *
 *   routeRequestsTo(server, [
 *     {
 *       path: "/transactions/refund/routePass",
 *       config: {
 *         validate: {
 *           payload: Joi.object({
 *             ticketId: Joi.number().integer().min(0).required(),
 *             targetAmt: Joi.number().min(0).required(),
 *             creditTag: Joi.string().disallow(INVALID_CREDIT_TAGS).required()
 *           })
 *         }
 *       }
 *     },
 *     {
 *       path: "/transactions/tickets/{ticketId}/refund/route_pass",
 *       config: {
 *         validate: {
 *           params: {
 *             ticketId: Joi.number().integer().required(),
 *           },
 *           payload: Joi.object({
 *             targetAmt: Joi.number().min(0).required(),
 *             creditTag: Joi.string().disallow(INVALID_CREDIT_TAGS).required()
 *           })
 *         }
 *       }
 *     }
 *  ],
 *  {
 *    method: "POST",
 *    config: { ... },
 *    handler: ...
 *  });
 */
export const routeRequestsTo = (server, paths, config) => paths.forEach(path => {
  server.route(_.merge({}, config, typeof path === 'string' ? { path } : path))
})

/**
 * Wraps an array of callbacks into a HAPI handler.
 * @param {...function} callbacks - functions that, when chained together,
 * will produce an object that is accepted by HAPI's reply callback
 * @example <caption>Using makeHandlerCallbackAdapter in HAPI routes</caption>
 *   // Define a function that looks up an instance for a given request
 *   const findContactListById = async (request) => {
 *     const m = getModels(request);
 *     const id = request.params.id;
 *     const listId = request.params.listId;
 *
 *     const contactListInst = await m.ContactList.findById(listId);
 *
 *     if (contactListInst) {
 *       InvalidArgumentError.assert(
 *         id === +contactListInst.transportCompanyId,
 *         'Telephone list ' + listId + ' does not belong to company ' + id
 *       );
 *     }
 *
 *     return contactListInst;
 *   };
 *
 *   //NOTE: Use of bind() discouraged for readability reasons
 *   const handleSingleListRequestWith =
 *     handleRequestWith.bind(null, findContactListById);
 *
 *   const retrieveContactList = handleSingleListRequestWith(l => l.toJSON());
 *   server.route({
 *     method: "GET",
 *     path: "/companies/{id}/contactLists/{listId}",
 *     config: { ... },
 *     handler: retrieveContactList
 *   });
 *
 *   const deleteContactList = handleSingleListRequestWith(async contactListInst => {
 *     await contactListInst.destroy();
 *     return contactListInst.toJSON();
 *   })
 *   server.route({
 *     method: "DELETE",
 *     path: "/companies/{id}/contactLists/{listId}",
 *     config: { ... },
 *     handler: deleteContactList
 *   });
 */
export const handleRequestWith = (...callbacks) => async (request, reply) => {
  const context = { db: getDB(request), models: getModels(request) }
  return reply(Promise
    .resolve(reduceCallbacksWith(request, request, context, callbacks))
    .catch(defaultErrorHandler(response => response))
  )
}

export const inSingleDBTransaction = (...callbacks) => (current, request, context) =>
  context.db.transaction(transaction => reduceCallbacksWith(current, request, {...context, transaction}, callbacks))

const reduceCallbacksWith = (initial, request, context, callbacks) => callbacks.reduce(
  (current, callback) => current.then(val => callback(val, request, context)),
  Promise.resolve(initial)
)

export const authorizeByRole = (role, lookupId = (passthrough, request) => request.params.id) =>
  (passthrough, request) => {
    auth.assertAdminRole(request.auth.credentials, role, lookupId(passthrough, request))
    return passthrough
  }

export const instToJSONOrNotFound = inst => inst ? inst.toJSON() : Boom.notFound()

export const assertThat = (f, { assert }, msg) => inst => { assert(f(inst), msg); return inst }

export const assertFound = assertThat(inst => inst, NotFoundError, 'Item not found')

export const deleteInst = async inst => {
  if (inst) {
    await inst.destroy()
  }
  return instToJSONOrNotFound(inst)
}
