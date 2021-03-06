const Sequelize = require("sequelize")
const assert = require("assert")

let cache = null

const ModelCache = require("./modelCache").default

const genModelAndTasks = seq => {
  const modelCache = new ModelCache(seq)

  modelCache.require("TransportCompany")
  modelCache.require("Route")
  modelCache.require("RouteAnnouncement")
  modelCache.require("Stop")
  modelCache.require("Driver")
  modelCache.require("Vehicle")
  modelCache.require("Trip")
  modelCache.require("TripStop")
  modelCache.require("User")
  modelCache.require("Ticket")
  modelCache.require("Admin")
  modelCache.require("Transaction")
  modelCache.require("Account")
  modelCache.require("TransactionItem")
  modelCache.require("Discount")
  modelCache.require("Promotion")
  modelCache.require("Payment")
  modelCache.require("RefundPayment")
  modelCache.require("Transfer")
  modelCache.require("Suggestion")
  modelCache.require("SuggestedRoute")

  modelCache.require("Alert")
  modelCache.require("Asset")
  modelCache.require("AdminCompany")
  modelCache.require("DriverCompany")
  modelCache.require("Subscription")
  modelCache.require("IndicativeTrip")
  modelCache.require("EventSubscription")
  modelCache.require("RouteCredit")
  modelCache.require("RoutePass")
  modelCache.require("PromoUsage")
  modelCache.require("ContactList")
  modelCache.require("Bid")
  modelCache.require("UserSuggestedRoute")
  modelCache.require("UserSuggestedRouteStop")

  modelCache.makeAssociations()
  return modelCache
}

const dbLogin = () => {
  // Grab the config parameters
  let sequelizeOptions = {
    logging: process.env.SHUTUP ? false : console.warn,
    pool: {
      max: Number(process.env.MAX_DB_CONNECTIONS) || 5,
      min: 0,
    },
  }

  // Find read replicas
  let replicas = []
  for (let key in process.env) {
    if (key.startsWith("HEROKU_POSTGRESQL")) {
      replicas.push(process.env[key])
    }
  }
  const parseReplica = replica => {
    // postgres URLs take the form postgres://user:password@host:port/database
    const parts = replica.match(
      /^postgres:\/\/(.+):(.+)@(.+):([0-9]{1,6})\/(.+)$/
    )
    assert(parts)
    const [, username, password, host, port, database] = parts
    return { host, port, username, password, database }
  }
  if (replicas.length > 0) {
    sequelizeOptions = {
      ...sequelizeOptions,
      replication: {
        read: replicas.map(parseReplica),
        write: parseReplica(process.env.DATABASE_URL),
      },
    }
  }

  // Throw an error if we don't have a databse url to connect to
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environmental variable not set")
  }

  // Creates the database connection and test it
  const sequelize = new Sequelize(process.env.DATABASE_URL, sequelizeOptions)
  sequelize.authenticate().catch(error => {
    console.error(error)
    process.exit(1)
  })

  return sequelize
}

module.exports = function() {
  if (!cache) {
    const db = dbLogin()
    const modelAndTask = genModelAndTasks(db, db.Sequelize)

    cache = {
      db: db,
      models: modelAndTask.models,
      syncTasks: modelAndTask.syncTasks,
      postSyncTasks: modelAndTask.postSyncTasks,
    }
  }

  return cache
}
