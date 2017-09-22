var Joi = require("joi")
const {getModels, defaultErrorHandler} = require("../util/common")
var Boom = require("boom")

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/regions",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        query: Joi.object({
          include_routes: Joi.boolean().default(false)
        }).unknown()
      }
    },

    handler: function (request, reply) {
      var m = getModels(request)
      var includes = []

      if (request.query.include_routes) {
        includes.push({
          model: m.Route
        })
      }

      m.Region.findAll({
        include: includes
      }).then((resp) => {
        reply(resp.map((x) => { return (x.toJSON()) }))
      }, defaultErrorHandler(reply))
    }
  })

  server.route({
    method: "GET",
    path: "/regions/{id}",
    config: {
      tags: ["api"],
      auth: false,
      validate: {
        params: {
          id: Joi.number().required()
        },
        query: Joi.object({
          include_routes: Joi.boolean().default(false)
        }).unknown()
      },
    },
    handler: function (request, reply) {
      var m = getModels(request)
      var includes = []

      if (request.query.include_routes) {
        includes.push({
          model: m.Route
        })
      }

      m.Region.findById(request.params.id, {
        include: includes
      }).then((resp) => {
        if (!resp) return reply(Boom.notFound())
        reply((resp.toJSON()))
      }).then(null, defaultErrorHandler(reply))
    }
  })

  server.route({
    method: "POST",
    path: "/regions",
    config: {
      tags: ["api"],
      auth: { access: {scope: ["superadmin"] }}
    },
    handler: function (request, reply) {
      var m = getModels(request)

      if (request.payload) {
        var region = request.payload

        delete region.id

        m.Region.create(region)
          .then((rv) => {
            reply(rv.toJSON())
          })
          .then(null, defaultErrorHandler(reply))
      } else {
        reply(Boom.badRequest(""))
      }
    }
  })

  server.route({
    method: "PUT",
    path: "/regions/{id}",
    config: {
      tags: ["api"],
      auth: { access: {scope: ["superadmin"] }},
      validate: {
        params: {
          id: Joi.number().integer()
        }
      }
    },
    handler: function (request, reply) {
      var m = getModels(request)

      if (request.payload) {
        m.Region
          .findById(request.params.id)
          .then((region) => {
            var new_region = request.payload
            delete new_region.id
            return region.update(new_region)
          })
          .then((region) => {
            reply(region.toJSON())
          })
          .then(null, defaultErrorHandler(reply))
      } else {
        reply(Boom.badRequest(""))
      }
    }
  })

  server.route({
    method: "DELETE",
    path: "/regions/{id}",
    config: {
      tags: ["api"],
      auth: { access: {scope: ["superadmin"] }},
      validate: {
        params: {
          id: Joi.number()
        }
      }
    },
    handler: function (request, reply) {
      var m = getModels(request)
      m.Region.findById(request.params.id)
        .then((region) => {
          return region.destroy()
        })
        .then(() => {
          reply("")
        })
        .then(null, defaultErrorHandler(reply))
    }
  })
  next()
}

register.attributes = {
  name: "endpoint-regions"
}
