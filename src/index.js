/* eslint no-console: 0 */
require("source-map-support").install()
// REQUIRED BY TELEGRAM
require("bluebird").config({ cancellation: true })
const Hapi = require("hapi")
const Inert = require("inert")
const Vision = require("vision")
const HapiSwagger = require("hapi-swagger")
const version = require("../package.json").version
const config = require("./config.js")
const routes = require("./lib/routes.js")
const events = require("./lib/events/events.js")
const AnalyticsPlugin = require("./lib/util/analytics.js")

// FORCE DATES TO BE INTEREPRETED AS UTC
// N.B. we are not overriding behaviour of timestamp type
// NEW BEHAVIOUR IN postgres-date
const DATE = /^(\d{1,})-(\d{2})-(\d{2})$/
require("pg").types.setTypeParser(1082, dateString => {
  return DATE.test(dateString) ? new Date(dateString) : null
})

// Check environment variables. Exit if any of the
// required ones don"t exist
const requiredVariables = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "DATABASE_URL",
  "AUTH0_SECRET",
]

// If DATABASE_URL is absent, check if we can put one together
// from AWS RDS equivalents
const rdsVariables = [
  "RDS_USERNAME",
  "RDS_PASSWORD",
  "RDS_HOSTNAME",
  "RDS_PORT",
  "RDS_DB_NAME",
]

const warnVariables = [
  "STRIPE_PK",
  "STRIPE_CID",
  "STRIPE_SK",
  "AUTH0_CID",
  "AUTH0_DOMAIN",
]

const checkExists = vars =>
  vars.forEach(v => {
    if (!process.env[v]) {
      console.log(`${v} environment variable is not set!`)
      throw new Error(`${v} environment variable is not set!`)
    }
  })

if (!process.env.DATABASE_URL) {
  console.warn("Attempting to construct DATABASE_URL from AWS RDS config")
  checkExists(rdsVariables)
  process.env.DATABASE_URL =
    `postgres://${process.env.RDS_USERNAME}:${process.env.RDS_PASSWORD}` +
    `@${process.env.RDS_HOSTNAME}:${process.env.RDS_PORT}/${
      process.env.RDS_DB_NAME
    }`
}

checkExists(requiredVariables)

for (let v of warnVariables) {
  if (!process.env[v]) {
    console.warn(
      `${v} environment variable is not set! This is not fatal, but you"d better not be in production!`
    )
  }
}

const server = new Hapi.Server({
  debug: {
    request: ["error"],
    log: ["error"],
  },
  app: {
    webDomain: process.env.WEB_DOMAIN || "staging.beeline.sg",
    emailDomain: process.env.EMAIL_DOMAIN || "staging.beeline.sg",
  },
})

// Configure the connection parameters
// SSL can be enabled by configuring the tls parameter in config.js
server.connection({
  port: process.env.PORT || config.port,
  tls: config.tls,
  routes: {
    cors: {
      additionalHeaders: [
        "Beeline-Device-UUID",
        "Beeline-Device-Model",
        "Beeline-Device-Serial",
        "Beeline-Device-Version",
        "Beeline-Device-Platform",
        "Beeline-Device-Manufacturer",
        "Beeline-App-Name",
      ],
      additionalExposedHeaders: ["Date"],
    },
  },
})

server.on("start", () => {
  events.emit("lifecycle", { stage: "start" })
})

server.on("stop", () => {
  events.emit("lifecycle", { stage: "stop" })
})

server.on("response", function({ info, method, url, response }) {
  console.log(
    `${info.remoteAddress} - ${method.toUpperCase()} ${url.path} -> ${
      (response || {}).statusCode
    }`
  )
})

// Set up Swagger to allow you to view API documentation
// at the root of http://<host>/
server
  .register([
    Inert,
    Vision,
    {
      register: HapiSwagger,
      options: {
        documentationPath: "/",
        info: {
          title: "Beeline API Documentation",
          version: version,
        },
      },
    },
  ])
  .then(() => {
    console.log("Registered Swagger")
  })
  // Main entry point for routing, connecting with the db, etc
  .then(() => server.register(routes))
  .then(() => {
    console.log("Registered routes")
  })
  .then(() => server.register(AnalyticsPlugin))
  .then(() => {
    console.log("Registered Analytics")
  })
  .then(() => server.start())
  .then(() => {
    console.log("Server started on port " + server.info.port)
  })
  // long run loop to send SMS to driver for assigned trip for now
  // Disable because we are not using SMS to send jobs to drivers
  // .then(()=>{
  //   if (!process.env.NO_DAEMON_MONITORING) {
  //     watchdog();
  //   }
  // })
  // Kill the process if there are any errors in registration or starting
  // Need to do this since node doesn"t crash on unhandled promises
  .catch(error => {
    events.emit("lifecycle", { stage: "error" })
    console.error(error)

    setTimeout(() => process.exit(1), 5000)
  })

process.on("SIGTERM", () => {
  server
    .stop({ timeout: 30 * 1000 })
    .then(() => {
      console.log("Server shutdown gracefully :)")
      server.plugins["sequelize"].db.close()
      process.exit(0)
    })
    .catch(err => {
      console.log("Ooops!", err)
    })
})

// Export the server as a module for testing purposes
module.exports = server
