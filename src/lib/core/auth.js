export const auth0Secret = process.env.AUTH0_SECRET
export const secretKey = auth0Secret
export const emailVerificationKey = auth0Secret
export const auth0Domain = process.env.AUTH0_DOMAIN

const Joi = require("joi")
const jwt = require("jsonwebtoken")
const leftPad = require("left-pad")
const _ = require("lodash")
const { models: m } = require("./dbschema")()
import assert from "assert"
import { SecurityError } from "../util/errors"
import { getModels } from "../util/common"

export const ADMIN_TASKS = [
  "refund",
  "issue-tickets",

  /* Public information */
  "manage-company",
  "manage-routes",
  "manage-notifications",
  "manage-customers",

  "view-drivers",
  "manage-drivers",

  "view-admins",
  "manage-admins",

  "view-transactions",
  "monitor-operations",

  /* tasks shared with driver */
  "view-passengers",
  "drive",
  "update-trip-status",
  "message-passengers",
]

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
  // Bearer token scheme
  server.auth.scheme("bearer", (scheme, opts) => {
    return {
      async authenticate(request, reply) {
        try {
          let token = checkBearer(request)
          let creds = await credentialsFromToken(token)

          reply.continue({
            credentials: creds,
          })
        } catch (err) {
          reply.continue({ credentials: { scope: "public" } })
        }
      },
    }
  })

  // register the strategies
  server.auth.strategy("bearer", "bearer", true)

  // Auth0 Client ID
  server.route({
    method: "GET",
    path: "/auth/credentials",
    config: {
      tags: ["api", "admin"],
      description:
        "Returns the Auth0 client id that you need to log in to this server",
    },
    handler(request, reply) {
      reply({
        domain: process.env.AUTH0_DOMAIN,
        cid: process.env.AUTH0_CID,
      })
    },
  })

  server.route({
    method: "GET",
    path: "/auth/loginAs",
    config: {
      tags: ["api"],
      description: "Allow superadmin login as any user type",
      validate: {
        query: {
          agentType: Joi.any()
            .valid(["user", "admin", "driver"])
            .required(),
          agentId: Joi.number()
            .integer()
            .required(),
        },
      },
      auth: { access: { scope: ["superadmin"] } },
    },
    handler(request, reply) {
      try {
        let m = getModels(request)
        let token
        switch (request.query.agentType) {
          case "admin":
            token = m.Admin.findById(request.query.agentId).then(admin => {
              return admin.makeToken()
            })
            break
          case "driver":
            token = m.Driver.findById(request.query.agentId).then(driver => {
              return driver.makeToken()
            })
            break
          case "user":
            token = m.User.findById(request.query.agentId).then(user => {
              return user.makeToken()
            })
            break
          default:
            token = Promise.resolve("")
        }
        token.then(data => {
          reply(data)
        })
      } catch (error) {
        console.error(error)
      }
    },
  })

  /* Users login is handled in users.js */
  next()
}

register.attributes = {
  name: "core-auth",
}

/**
 * Given an **admin**'s token, return the data to be placed in `credentials`.
 * The `credentials` object will be accessible from `request.auth.credentials`
 *
 * Permissions will be placed in `credentials.permissions` by looking up the
 * database
 *
 * @param {object} token
 * @return {object} The `credentials` object
 */
async function adminCredentials(token) {
  const email = _.get(token, "app_metadata.email", _.get(token, "email"))
  const iat = token.iat

  assert(email)

  const canonicalEmail = email.toLowerCase()

  const adminInstance = await m.Admin.find({
    where: { email: canonicalEmail },
  })

  // Authorize for only the companies admin is allowed to access
  const creds = {
    scope: "admin",
    email: canonicalEmail,
    adminId: adminInstance.id,
    iat,
  }

  const adminCompanies = await m.AdminCompany.findAll({
    where: { adminId: adminInstance.id },
    raw: true,
    attributes: ["transportCompanyId", "permissions"],
  })

  creds.transportCompanyIds = adminCompanies.map(c => c.transportCompanyId)
  creds.permissions = _(adminCompanies)
    .keyBy(c => c.transportCompanyId)
    .mapValues(c => c.permissions)
    .value()

  return creds
}

/**
 * Given a **superadmin**'s token, return the data to be placed in `credentials`.
 * The `credentials` object will be accessible from `request.auth.credentials`
 *
 * All known permissions will be placed in `credentials.permissions`.
 *
 * @param {object} token
 * @return {object} The `credentials` object
 */
async function superadminCredentials(token) {
  let creds = {
    scope: "superadmin",
    email: token.email,
    iat: token.iat,
  }

  // Authorize for all companies
  const companies = await m.TransportCompany.findAll({
    attributes: ["id"],
    raw: true,
  })

  // Find the admin user on which we store data, if such a user exists
  const adminInst = await m.Admin.findOne({ where: { email: token.email } })

  creds.transportCompanyIds = companies.map(c => c.id)

  // Grant all permissions to superadmin
  creds.permissions = _(creds.transportCompanyIds)
    .keyBy()
    .mapValues(key => ADMIN_TASKS)
    .value()

  creds.adminId = adminInst && adminInst.id

  return creds
}

/**
 * Given an **driver**'s token, return the data to be placed in `credentials`.
 * The `credentials` object will be accessible from `request.auth.credentials`
 *
 * Default permissions for drivers will be given ('drive', 'update-trip-status',
 * 'message-passengers', 'view-passengers')
 *
 * @param {object} token
 * @return {object} The `credentials` object
 */
async function driverCredentials(token) {
  let driverId = _.get(token, "app_metadata.driverId", _.get(token, "driverId"))
  assert(driverId)
  assert.strictEqual(typeof driverId, "number")

  let transportCompanies = await m.DriverCompany.findAll({
    where: { driverId },
    raw: true,
    attributes: ["transportCompanyId"],
  })

  let creds = {
    scope: "driver",
    driverId,
  }

  creds.transportCompanyIds = transportCompanies.map(c => c.transportCompanyId)
  creds.permissions = _(transportCompanies)
    .keyBy(k => k.transportCompanyId)
    .mapValues(key => [
      "drive",
      "update-trip-status",
      "message-passengers",
      "view-passengers",
    ])
    .value()

  return creds
}

/**
 * Given a **user**'s token, return the data to be placed in `credentials`.
 * The `credentials` object will be accessible from `request.auth.credentials`
 *
 * Users have no permissions.
 *
 * @param {object} token
 * @return {object} The `credentials` object
 */
async function userCredentials(token) {
  let userId = _.get(token, "app_metadata.userId", _.get(token, "userId"))
  assert(userId)
  assert.strictEqual(typeof userId, "number")

  let creds = { scope: "user", userId, iat: token.iat }

  // User can only log in from one place at any time
  let userInstance = await m.User.findById(creds.userId)
  // iat only has a granularity of 1 second, so be a bit more generous with time
  assert(userInstance.lastLogin <= (token.iat + 1) * 1000)

  return creds
}

/**
 * Given a parsed token, return the credentials object. This will
 * depend on what `role` is specified in the token.
 *
 * @param {*} tokenData
 * @return {object} The `credentials` object
 */
export async function credentialsFromToken(tokenData) {
  let creds = {}
  let role = _.get(tokenData, "app_metadata.roles[0]", _.get(tokenData, "role"))

  if (role === "admin") return adminCredentials(tokenData)
  if (role === "user") return userCredentials(tokenData)
  if (role === "driver") return driverCredentials(tokenData)
  if (role === "superadmin") return superadminCredentials(tokenData)

  return creds
}

/**
 * @param {object} credentials
 * @param {string} role
 * @return {array<number>} List of company IDs for which this `credentials`
 * has permissions to a particular `role`
 */
export function getCompaniesByRole(credentials, role) {
  if (!credentials.permissions) {
    return []
  }

  return _(credentials.permissions)
    .pickBy(v => v.indexOf(role) !== -1)
    .keys()
    .map(id => parseInt(id))
    .value()
}

/**
 * Asserts that `credentials` has permissions to `role` of `companyId`.
 * Throws a SecurityError otherwise
 * @param {object} credentials
 * @param {string} role
 * @param {number} companyId
 * @param {boolean} allowSuperadmin
 * @param {string} message
 * @return {*}
 */
export function assertAdminRole(
  credentials,
  role,
  companyId,
  allowSuperadmin = true,
  message = ""
) {
  if (
    credentials.permissions &&
    credentials.permissions[companyId] &&
    credentials.permissions[companyId].indexOf(role) !== -1
  ) {
    return
  }

  if (companyId === undefined) {
    return _.some(credentials.permissions, p => p.indexOf(role) !== -1)
  }

  throw new SecurityError(`User is not in role: ${role}`)
}

/**
 * Verifies a token
 * @param {*} token
 * @return {object} Token payload
 */
export function checkToken(token) {
  // FIXME: Must also check the last updated time
  // Otherwise after the user changes his/her password,
  // the malicious user remains logged in
  return jwt.verify(token, secretKey)
}

/**
 * Verifies that a request has an `Authorization`
 * header, and that the Bearer token is a valid JWT.
 * @param {*} req
 * @return {object} Token payload
 */
export function checkBearer(req) {
  let auth = req.headers.authorization || ""
  let parts = auth.split(" ")

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new Error()
  }

  return checkToken(parts[1])
}

/**
 * Sign a token payload for use as session token. Currently
 * not time-limited.
 *
 * FIXME: Should be a limited time with renew tokens
 * @param {object} payload
 * @return {string} Signed payload
 */
export function signSession(payload) {
  return jwt.sign(payload, secretKey)
}

/**
 * Verify a session token string
 * @param {object} payload
 * @return {string} Token payload, if successful. Else throws error
 */
export function verifySession(payload) {
  return jwt.verify(payload, secretKey)
}

/**
 * Sign a token payload for a longer time (2hrs). These token lifespan
 * is intended for use with email verification
 * @param {object} payload
 * @return {string} Signed payload
 */
export function signVerification(payload) {
  return jwt.sign(payload, emailVerificationKey, {
    expiresIn: "2h",
  })
}

/**
 * Verify a token string
 * @param {object} payload
 * @return {string} Token payload, if successful. Else throws error
 */
export function verifyVerification(payload) {
  return jwt.verify(payload, emailVerificationKey)
}

/**
 * Sign a token payload for a short time (30mins)
 * @param {object} payload
 * @return {string} Signed payload
 */
export function signImmediate(payload) {
  return jwt.sign(payload, emailVerificationKey, {
    expiresIn: "30m",
  })
}
export const verifyImmediate = verifyVerification

/**
 * @param {number} n
 * @return {string} Randomly generated `n`-digit string
 */
export function randomNDigits(n) {
  n = n || 6

  let randomCode = leftPad(Math.floor(Math.random() * Math.pow(10, n)), n, "0")
  return randomCode
}

/**
 * Some of our database objects (User, Admin etc.) have a `lastComms`
 * attribute. This function checks whether the time since `lastComms`
 * exceeds a predefined amount of time (10s).
 * @param {object} objInstance - The database object
 * @return {boolean} True if no rate limit required, False if the last
 *  comms was very recent (might want to rate limit)
 */
export function ensureRateLimit(objInstance) {
  assert("lastComms" in objInstance)
  let now = new Date().getTime()
  let lastComms = objInstance.lastComms ? objInstance.lastComms.getTime() : null

  if (!lastComms || now - lastComms > 10000) {
    objInstance.lastComms = now
    return true
  } else {
    return false
  }
}
