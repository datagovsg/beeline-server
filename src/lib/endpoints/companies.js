let Joi = require("joi")
let common = require("../util/common")
let Boom = require("boom")
let Identicon
let auth = require("../core/auth")
const payment = require("../transactions/payment")
import assert from "assert"
import commonmark from "commonmark"
import querystring from "querystring"
import BlueBird from "bluebird"
import sharp from "sharp"
import { imageMimeForMagicBytes } from "../util/image"
import { InvalidArgumentError } from "../util/errors"

let getModels = common.getModels
let defaultErrorHandler = common.defaultErrorHandler

const cleanCompanyInfo = function cleanCompanyInfo(company) {
  if (company.clientSecret) delete company.clientSecret
  if (company.sandboxSecret) delete company.sandboxSecret
  return company
}

try {
  Identicon = require("identicon")
} catch (err) {
  console.error(`Ignoring the following error while loading identicon:`, err)
}

export const register = function register(server, options, next) {
  server.route({
    method: "GET",
    path: "/companies",
    config: {
      tags: ["api", "admin", "commuter"],
      auth: false,
    },

    handler: function(request, reply) {
      let m = common.getModels(request)
      m.TransportCompany.findAll().then(resp => {
        reply(
          resp.map(x => {
            return cleanCompanyInfo(x.toJSON())
          })
        )
      }, defaultErrorHandler(reply))
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{id}",
    config: {
      tags: ["api", "admin", "commuter"],
      auth: false,
      validate: {
        params: {
          id: Joi.number(),
        },
      },
    },
    handler: function(request, reply) {
      let m = common.getModels(request)
      m.TransportCompany.unscoped()
        .findById(request.params.id, {
          attributes: { exclude: ["logo"] },
        })
        .then(resp => {
          if (!resp) return reply(Boom.notFound())
          reply(cleanCompanyInfo(resp.toJSON()))
        })
        .then(null, common.defaultErrorHandler(reply))
    },
  })

  server.route({
    method: "POST",
    path: "/companies",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: "superadmin" } },
      validate: {
        payload: {
          name: Joi.string(),
          email: Joi.string(),
          contactNo: Joi.string(),
          features: Joi.string(),
          terms: Joi.string(),
          smsOpCode: Joi.string().regex(/^[a-zA-Z0-9]{0,11}$/),
          referrer: Joi.string().optional(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-company",
          request.params.id
        )

        if (request.auth.credentials.scope !== "superadmin") {
          assert(
            !request.payload.referrer,
            "Referrer may only be set by Superadmin"
          )
        }

        let companyInst = await m.TransportCompany.create(request.payload)

        reply(companyInst.toJSON())
      } catch (err) {
        common.defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "PUT",
    path: "/companies/{id}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: ["admin", "superadmin"] } },
      validate: {
        params: {
          id: Joi.number().integer(),
        },
        payload: {
          name: Joi.string(),
          email: Joi.string(),
          contactNo: Joi.string(),
          features: Joi.string(),
          terms: Joi.string(),
          smsOpCode: Joi.string().regex(/^[a-zA-Z0-9]{0,11}$/),
          referrer: Joi.string(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)
        let companyInst = await m.TransportCompany.unscoped().findById(
          request.params.id
        )

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-company",
          request.params.id
        )

        if (request.auth.credentials.scope !== "superadmin") {
          assert(
            !request.payload.referrer,
            "Referrer may only be set by Superadmin"
          )
        }

        await companyInst.update(request.payload)

        reply(companyInst.toJSON())
      } catch (err) {
        common.defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "DELETE",
    path: "/companies/{id}",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: "superadmin" } },
      validate: {
        params: {
          id: Joi.number(),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)
        let companyInst = await m.TransportCompany.findById(request.params.id)

        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-company",
          request.params.id
        )

        await companyInst.destroy()

        reply(companyInst.toJSON())
      } catch (err) {
        common.defaultErrorHandler(reply)(err)
      }
    },
  })
  server.route({
    method: "GET",
    path: "/companies/{id}/logo",
    config: {
      tags: ["api", "admin", "commuter"],
      description: `
Get the company's logo. Generates an identicon for the
company if the logo is not available
`,
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
        },
        query: {
          width: Joi.number()
            .integer()
            .allow(null)
            .default(null),
          height: Joi.number()
            .integer()
            .allow(null)
            .default(null),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let company = await m.TransportCompany.findById(request.params.id, {
          attributes: ["logo"],
        })

        if (company == null) {
          return reply(Boom.notFound(request.params.id))
        }

        if (!company.logo && Identicon) {
          let identicon = await BlueBird.promisify(Identicon.generate)({
            id: "Beeline!" + request.params.id,
            size: 100,
          })

          company.logo = identicon
          await company.save()
          reply(company.logo).header("Content-type", "image/png")
        } else {
          if (company.logo) {
            let logo = sharp(company.logo)

            if (request.query.width || request.query.height) {
              logo = logo.resize(request.query.width, request.query.height)
            }

            const [logoBuffer, metadata] = await Promise.all([
              logo.toBuffer(),
              logo.metadata(),
            ])

            reply(logoBuffer).header(
              "Content-type",
              metadata.format === "png"
                ? "image/png"
                : metadata.format === "jpeg"
                  ? "image/jpeg"
                  : "application/x-octet-stream"
            )
          } else {
            reply(null)
          }
        }
      } catch (err) {
        console.error(err)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/{id}/html/{content}",
    config: {
      tags: ["api", "admin", "commuter"],
      description: `Renders the Terms and Conditions as HTML from Markdown`,
      validate: {
        params: {
          id: Joi.number()
            .integer()
            .required(),
          content: Joi.any().valid(["terms", "features"]),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = getModels(request)
        let company = await m.TransportCompany.findById(request.params.id, {
          attributes: [request.params.content],
        })

        if (company == null) {
          return reply(Boom.notFound(request.params.id))
        }

        let reader = new commonmark.Parser({ safe: true })
        let writer = new commonmark.HtmlRenderer({ safe: true })
        let parsed = reader.parse(company[request.params.content])
        return reply(writer.render(parsed))
      } catch (err) {
        console.error(err)
        reply(Boom.badImplementation(err.message))
      }
    },
  })

  server.route({
    method: "POST",
    path: "/companies/{id}/logo",
    config: {
      tags: ["api", "admin"],
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
          logo: Joi.any(),
        },
      },
      auth: false,
      description: `
Upload a logo for a company

Note that this uses the traditional file upload mechanism, not AJAX.
Moreover the standard \`Authorization\` header is not used.
Instead, pass the session token in the form data.
To construct a form, use something like:

<pre>
&lt;form method="POST"
enctype="multipart/form-data"
action="/companies/10/logo"
>

&lt;input type="hidden" name="sessionToken" value="&lt;SESSION TOKEN>">
&lt;input type="file" name="logo">
&lt;button type="submit">Upload!&lt;/button>
&lt;/form>
</pre>
    `,
    },
    async handler(request, reply) {
      /* Authenticate -- we're not using an AJAX call here so this is necessary */
      try {
        request.auth.credentials = await auth.credentialsFromToken(
          auth.checkToken(request.payload.sessionToken)
        )
        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-company",
          request.params.id
        )
      } catch (err) {
        console.error(err)
        reply(Boom.forbidden())
      }

      try {
        let m = getModels(request)
        let data = request.payload

        assert(data.logo)

        // FIXME: If there's a file, downsize it!!
        let company = await m.TransportCompany.findById(request.params.id)
        let bufs = []

        if (!company) {
          return reply(Boom.forbidden())
        }

        // read into buffer;
        await new Promise((resolve, reject) => {
          data.logo.on("data", d => {
            bufs.push(d)
          })
          data.logo.on("end", resolve)
          data.logo.on("error", reject)
        })

        company.logo = Buffer.concat(bufs)

        const mime = imageMimeForMagicBytes(company.logo)
        if (mime === null) {
          throw new InvalidArgumentError(
            "Unknown magic bytes. Image MIME cannot be determined"
          )
        } else {
          reply(company.logo).header("Content-Type", mime)
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "POST",
    path: "/companies/{id}/stripeConnect",
    config: {
      tags: ["api", "admin"],
      auth: { access: { scope: "admin" } },
      validate: {
        payload: {
          redirect: Joi.string(),
        },
        params: {
          id: Joi.number().integer(),
        },
      },
      description: `Returns the Stripe URL where the user can connect to our app`,
    },
    async handler(request, reply) {
      try {
        await auth.assertAdminRole(
          request.auth.credentials,
          "manage-company",
          request.params.id
        )

        let options = {
          response_type: "code",
          client_id: process.env.STRIPE_CID,
          state: auth.signVerification({
            action: "stripeConnect",
            redirect: request.payload.redirect,
            transportCompanyId: request.params.id,
          }),
          stripe_landing: "login",
          scope: "read_write",
        }
        return reply(
          `https://connect.stripe.com/oauth/authorize?${querystring.stringify(
            options
          )}`
        )
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  server.route({
    method: "GET",
    path: "/companies/stripeConnect",
    config: {
      tags: ["api", "admin"],
      auth: false,
      validate: {
        query: {
          code: Joi.string().required(),
          state: Joi.string().required(),
          scope: Joi.valid("read_write"),
        },
      },
    },
    async handler(request, reply) {
      try {
        let m = common.getModels(request)

        // Decode the state
        let { action, redirect, transportCompanyId } = auth.verifyImmediate(
          request.query.state
        )

        assert.strictEqual(action, "stripeConnect", "Invalid token action")

        // Use stripe to connect...
        let connectResult = await payment.connectAccount(request.query.code)

        // Check the results and update the database
        assert(
          connectResult.stripe_user_id,
          `Error obtaining user id from ${connectResult}`
        )

        if (connectResult.livemode) {
          await m.TransportCompany.update(
            {
              sandboxId: connectResult.stripe_user_id,
              clientId: connectResult.stripe_user_id,
            },
            {
              where: {
                id: transportCompanyId,
              },
            }
          )
        } else {
          await m.TransportCompany.update(
            {
              clientId: connectResult.stripe_user_id,
              sandboxId: connectResult.stripe_user_id,
            },
            {
              where: {
                id: transportCompanyId,
              },
            }
          )
        }

        if (redirect) {
          reply({}).redirect(redirect)
        } else {
          reply()
        }
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })
  next()
}
register.attributes = {
  name: "endpoint-companies",
}
