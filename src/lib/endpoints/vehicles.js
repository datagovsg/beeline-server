let Joi = require("joi")
let common = require("../util/common")
let Boom = require("boom")
let auth = require("../core/auth")
import assert from "assert"
import { Buffer } from "buffer"
import BlueBird from "bluebird"

try {
  var Identicon = require("identicon")
} catch (err) {
  console.log(`Error while loading identicon: ${err}`)
}

let getModels = common.getModels
let defaultErrorHandler = common.defaultErrorHandler

/**
 * Returns a Sequelize WHERE clause suited
 * for determining whether the user credentials
 * is authorized to make changes to the vehicle
 */
function authenticateAgent(id, request) {
  let m = getModels(request)
  let creds = request.auth.credentials

  let query = {
    where: {},
    include: [
      {
        model: m.Driver,
        // where: {
        //   $or: [ // role == 'admin' ==> company id must match
        //     request.auth.credentials.role != "admin",
        //     {transportCompanyId: creds.transportCompanyId}
        //   ]
        // }
      },
    ],
  }

  // if specific id was requested...
  if (id != null && id !== undefined) {
    query.where.id = id
  }

  query.where.$or = [
    request.auth.credentials.scope === "superadmin",
    request.auth.credentials.scope === "admin",
    {
      $and: [
        request.auth.credentials.scope === "driver",
        { driverId: creds.driverId },
      ],
    },
  ]

  return query
}

export function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/vehicles/{id}/photo",
    config: {
      tags: ["api"],
      description: `
Get the vehicle's photo. Generates an identicon for the
vehicle if the photo is not available.
`,
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let vehicle = await m.Vehicle.findById(request.params.id)

        if (vehicle == null) {
          return reply(Boom.notFound(request.params.id))
        }

        if (!vehicle.photo && Identicon) {
          let identicon = await BlueBird.promisify(Identicon.generate)({
            id: "Beeline!" + request.params.id,
            size: 100,
          })

          vehicle.photo = identicon
          await vehicle.save()
          reply(vehicle.photo).header("Content-type", "image/png")
        } else {
          if (
            vehicle.photo[0] === 137 &&
            vehicle.photo[1] === "P".charCodeAt(0)
          ) {
            reply(vehicle.photo).header("Content-type", "image/png")
          } else if (vehicle.photo[0] === "J".charCodeAt(0)) {
            reply(vehicle.photo).header("Content-type", "image/jpeg")
          }
        }
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  server.route({
    method: "POST",
    path: "/vehicles/{id}/photo",
    config: {
      tags: ["api"],
      payload: {
        output: "stream",
        parse: "true",
        allow: "multipart/form-data",
        maxBytes: 5000000,
      },
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
        },
        payload: {
          sessionToken: Joi.string(),
          photo: Joi.any(),
        },
      },
      auth: false,
      description: `
Upload a photo for a vehicle.

Note that this uses the traditional file upload mechanism, not AJAX.
Moreover the standard \`Authorization\` header is not used.
Instead, pass the session token in the form data.
 To construct a form, use something like:
<pre>
&lt;form method="POST"
    enctype="multipart/form-data"
    action="/vehicles/10/photo"
>

    &lt;input type="hidden" name="sessionToken" value="&lt;SESSION TOKEN>">
    &lt;input type="file" name="photo">
    &lt;button type="submit">Upload!&lt;/button>
&lt;/form>
</pre>

`,
    },
    async handler(request, reply) {
      /* Authenticate -- we're not using an AJAX call here so this is necessary */
      try {
        request.auth.credentials = auth.checkToken(request.payload.sessionToken)
      } catch (err) {
        console.log(err.stack)
        reply(Boom.forbidden())
      }

      try {
        let m = getModels(request)
        let data = request.payload
        let vehicle = await m.Vehicle.findOne(
          authenticateAgent(request.params.id, request)
        )
        let bufs = []

        assert(data.photo)
        if (!vehicle) {
          return reply(Boom.forbidden())
        }

        // read into buffer;
        await new Promise((resolve, reject) => {
          data.photo.on("data", d => {
            bufs.push(d)
          })
          data.photo.on("end", resolve)
          data.photo.on("error", reject)
        })

        vehicle.photo = Buffer.concat(bufs)
        await vehicle.save()
        reply("")
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  server.route({
    method: "GET",
    path: "/vehicles",
    config: {
      tags: ["api", "admin", "driver"],
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
    },
    handler: function(request, reply) {
      let m = common.getModels(request)

      m.Vehicle.findAll(authenticateAgent(null, request))
        .then(vehicles => {
          reply(vehicles.map(vehicle => vehicle.toJSON()))
        })
        .then(null, defaultErrorHandler(reply))
    },
  })

  server.route({
    method: "GET",
    path: "/vehicles/{id}",
    config: {
      tags: ["api", "admin", "driver"],
      description: "Get a vehicle",
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
      },
    },
    async handler(request, reply) {
      let m = common.getModels(request)

      try {
        let resp = await m.Vehicle.findOne(
          authenticateAgent(request.params.id, request)
        )
        if (resp) {
          reply(resp.toJSON())
        } else {
          reply(null)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  /** Create a new vehicle **/
  server.route({
    method: "POST",
    path: "/vehicles",
    config: {
      tags: ["api", "admin", "driver"],
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
      validate: {
        payload: Joi.object({
          vehicleNumber: Joi.string(),
          driverId: Joi.number()
            .integer()
            .optional(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        if (request.auth.credentials.scope === "driver") {
          request.payload.driverId = request.auth.credentials.driverId
        } else {
          if (typeof request.payload.driverId === "undefined") {
            throw new Error("Must define driver ID")
          }
        }

        // check for existing vehicles with same number
        if (
          (await m.Vehicle.findOne({
            where: {
              vehicleNumber: request.payload.vehicleNumber,
              driverId: request.payload.driverId,
            },
          })) != null
        ) {
          throw new Error("Vehicle with this vehicle number already exists")
        }

        // otherwise create the vehicle
        let vehicle = await m.Vehicle.create(request.payload)
        reply(vehicle.toJSON())
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badRequest(err.message))
      }
    },
  })

  /* Update the vehicle name */
  server.route({
    method: "PUT",
    path: "/vehicles/{id}",
    config: {
      tags: ["api", "admin", "driver"],
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
      validate: {
        payload: Joi.object({
          vehicleNumber: Joi.string(),
          driverId: Joi.number()
            .integer()
            .optional(),
        }),
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        if (request.auth.credentials.role === "admin") {
          request.payload.driverId = request.auth.credentials.driverId
        }

        let result = await m.Vehicle.update(
          request.payload,
          authenticateAgent(request.params.id, request)
        )

        if (result[0] === 0) {
          return reply(Boom.notFound())
        }

        reply((await m.Vehicle.findById(request.params.id)).toJSON())
      } catch (err) {
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  /* Delete */
  server.route({
    method: "DELETE",
    path: "/vehicles/{id}",
    config: {
      tags: ["api", "admin", "driver"],
      auth: { access: { scope: ["driver", "admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
        },
      },
    },
    handler: async function(request, reply) {
      try {
        let m = getModels(request)

        let result = await m.Vehicle.destroy(
          authenticateAgent(request.params.id, request)
        )
        if (result[0] === 0) {
          return reply(Boom.notFound())
        } else {
          reply("")
        }
      } catch (err) {
        console.log(err.stack)
        reply(Boom.badImplementation(err.message))
      }
    },
  })
  next()
}
register.attributes = {
  name: "endpoints-vehicles",
}
