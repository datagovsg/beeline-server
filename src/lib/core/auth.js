export var auth0Secret = process.env.AUTH0_SECRET
export var secretKey = auth0Secret
export var emailVerificationKey = auth0Secret
export var auth0Domain = process.env.AUTH0_DOMAIN

const Joi = require("joi")
const jwt = require("jsonwebtoken")
const leftPad = require("left-pad")
const _ = require('lodash')
const {models: m} = require('./dbschema')()
import assert from "assert"
import {SecurityError} from '../util/errors'
import {getModels} from '../util/common'

export const ADMIN_TASKS = [
  'refund',
  'issue-tickets',

  /* Public information */
  'manage-company',
  'manage-routes',
  'manage-notifications',
  'manage-customers',

  'view-drivers',
  'manage-drivers',

  'view-admins',
  'manage-admins',

  'view-transactions',
  'monitor-operations',

  /* tasks shared with driver */
  'view-passengers',
  'drive',
  'update-trip-status',
  'message-passengers',
]

export function register (server, options, next) {
  // Bearer token scheme
  server.auth.scheme("bearer", (scheme, opts) => {
    return {
      async authenticate (request, reply) {
        try {
          var token = checkBearer(request)
          var creds = await credentialsFromToken(token)

          reply.continue({
            credentials: creds
          })
        } catch (err) {
          reply.continue({credentials: {scope: "public"}})
        }
      }
    }
  })

  // register the strategies
  server.auth.strategy("bearer", "bearer", true)

  // Auth0 Client ID
  server.route({
    method: "GET",
    path: "/auth/credentials",
    config: {
      tags: ["api"],
      description: "Returns the Auth0 client id that you need to log in to this server"
    },
    handler (request, reply) {
      reply({
        domain: process.env.AUTH0_DOMAIN,
        cid: process.env.AUTH0_CID,
      })
    }
  })

  server.route({
    method: "GET",
    path: "/auth/loginAs",
    config: {
      tags: ["api"],
      description: "Allow superadmin login as any user type",
      validate: {
        query: {
          agentType: Joi.any().valid(['user', 'admin', 'driver']).required(),
          agentId: Joi.number().integer().required()
        }
      },
      auth: {access: {scope: ['superadmin']}}
    },
    handler (request, reply) {
      try {
        var m = getModels(request)
        var token
        switch (request.query.agentType) {
          case 'admin':
            token = m.Admin.findById(request.query.agentId).then((admin) => {
              return admin.makeToken()
            })
            break
          case 'driver':
            token = m.Driver.findById(request.query.agentId).then((driver) => {
              return driver.makeToken()
            })
            break
          case 'user':
            token = m.User.findById(request.query.agentId).then((user) => {
              return user.makeToken()
            })
            break
          default: token = Promise.resolve('')
        }
        token.then((data) => {
          reply(data)
        })
      } catch (error) {
        console.log(error.stack)
      }
    }
  })

  /* Users login is handled in users.js */
  next()
}

register.attributes = {
  name: "core-auth"
}

async function adminCredentials (token) {
  const email = _.get(token, 'app_metadata.email', _.get(token, 'email'))
  const iat = token.iat

  assert(email)

  const canonicalEmail = email.toLowerCase()

  const adminInstance = await m.Admin.find({
    where: {email: canonicalEmail}
  })

  // Authorize for only the companies admin is allowed to access
  const creds = {
    scope: 'admin',
    email: canonicalEmail,
    adminId: adminInstance.id,
    iat
  }

  const adminCompanies = await m.AdminCompany.findAll({
    where: {adminId: adminInstance.id},
    raw: true,
    attributes: ['transportCompanyId', 'permissions']
  })

  creds.transportCompanyIds = adminCompanies.map(c => c.transportCompanyId)
  creds.permissions = _(adminCompanies)
    .keyBy(c => c.transportCompanyId)
    .mapValues(c => c.permissions)
    .value()

  return creds
}

async function superadminCredentials (token) {
  var creds = {
    scope: 'superadmin',
    email: token.email,
    iat: token.iat
  }

  // Authorize for all companies
  const companies = await m.TransportCompany.findAll({
    attributes: ['id'],
    raw: true,
  })

  // Find the admin user on which we store data, if such a user exists
  const adminInst = await m.Admin.findOne({where: {email: token.email}})

  creds.transportCompanyIds = companies.map(c => c.id)

  // Grant all permissions to superadmin
  creds.permissions = _(creds.transportCompanyIds)
    .keyBy()
    .mapValues(key => ADMIN_TASKS)
    .value()

  creds.adminId = adminInst && adminInst.id

  return creds
}

async function driverCredentials (token) {
  var driverId = _.get(token, 'app_metadata.driverId', _.get(token, 'driverId'))
  assert(driverId)
  assert.strictEqual(typeof driverId, 'number')

  var transportCompanies = await m.DriverCompany.findAll({
    where: {driverId},
    raw: true,
    attributes: ['transportCompanyId']
  })

  var creds = {
    scope: 'driver',
    driverId
  }

  creds.transportCompanyIds = transportCompanies.map(c => c.transportCompanyId)
  creds.permissions = _(transportCompanies)
    .keyBy(k => k.transportCompanyId)
    .mapValues(key => ['drive', 'update-trip-status', 'message-passengers', 'view-passengers'])
    .value()

  return creds
}
async function userCredentials (token) {
  var userId = _.get(token, 'app_metadata.userId', _.get(token, 'userId'))
  assert(userId)
  assert.strictEqual(typeof userId, 'number')

  var creds = {scope: 'user', userId, iat: token.iat}

  // User can only log in from one place at any time
  var userInstance = await m.User.findById(creds.userId)
  // iat only has a granularity of 1 second, so be a bit more generous with time
  assert(userInstance.lastLogin <= (token.iat + 1) * 1000)

  return creds
}

export async function credentialsFromToken (tokenData) {
  var creds = {}
  var role = _.get(tokenData, 'app_metadata.roles[0]', _.get(tokenData, 'role'))

  if (role === 'admin') return adminCredentials(tokenData)
  if (role === 'user') return userCredentials(tokenData)
  if (role === 'driver') return driverCredentials(tokenData)
  if (role === 'superadmin') return superadminCredentials(tokenData)

  return creds
}


export function getCompaniesByRole (credentials, role) {
  if (!credentials.permissions) {
    return []
  }

  return _(credentials.permissions)
    .pickBy(v => v.indexOf(role) !== -1)
    .keys()
    .map(id => parseInt(id))
    .value()
}

export function assertAdminRole (credentials, role, companyId, allowSuperadmin = true, message = '') {
  if (credentials.permissions &&
      credentials.permissions[companyId] &&
      credentials.permissions[companyId].indexOf(role) !== -1) {
    return
  }

  if (companyId === undefined) {
    return _.some(credentials.permissions, p => p.indexOf(role) !== -1)
  }

  throw new SecurityError(`User is not in role: ${role}`)
}

export function checkToken (token) {
  // FIXME: Must also check the last updated time
  // Otherwise after the user changes his/her password,
  // the malicious user remains logged in
  return jwt.verify(token, secretKey)
}

export function checkBearer (req) {
  var auth = req.headers.authorization || ""
  var parts = auth.split(" ")

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new Error()
  }

  return checkToken(parts[1])
}

/* Signing of sessions. FIXME: Should be a limited time with renew tokens */
export function signSession (payload) {
  return jwt.sign(payload, secretKey)
}
export function verifySession (payload) {
  return jwt.verify(payload, secretKey)
}

/* Signing of verification emails, keys. Comes with a time limit */
export function signVerification (payload) {
  return jwt.sign(payload, emailVerificationKey, {
    expiresIn: "2h"
  })
}
export function verifyVerification (payload) {
  return jwt.verify(payload, emailVerificationKey)
}

/* Shorter time limit than signVerification */
export function signImmediate (payload) {
  return jwt.sign(payload, emailVerificationKey, {
    expiresIn: "30m"
  })
}
export var verifyImmediate = verifyVerification

export function randomNDigits (n) {
  n = n || 6

  var randomCode = leftPad(Math.floor(Math.random() * Math.pow(10, n)), n, "0")
  return randomCode
}


export function ensureRateLimit (objInstance) {
  assert("lastComms" in objInstance)
  var now = new Date().getTime()
  var lastComms = objInstance.lastComms ? objInstance.lastComms.getTime() : null

  if (!lastComms || now - lastComms > 10000) {
    objInstance.lastComms = now
    return true
  } else {
    return false
  }
}
