const _ = require('lodash')
const Sequelize = require("sequelize")
const config = require("../../config")

var cache = null

module.exports = function () {
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

const ModelCache = require('./modelCache').default

function genModelAndTasks (seq, Sequelize) {
  var modelCache = new ModelCache(seq)

  modelCache.require('TransportCompany')
  modelCache.require('Route')
  modelCache.require('RouteAnnouncement')
  modelCache.require('Region')
  modelCache.require('RouteRegion')
  modelCache.require('Stop')
  modelCache.require('Driver')
  modelCache.require('Vehicle')
  modelCache.require('Trip')
  modelCache.require('TripStop')
  modelCache.require('User')
  modelCache.require('Ticket')
  modelCache.require('Admin')
  modelCache.require('Transaction')
  modelCache.require('Account')
  modelCache.require('TransactionItem')
  modelCache.require('Discount')
  modelCache.require('Promotion')
  modelCache.require('Payment')
  modelCache.require('RefundPayment')
  modelCache.require('Transfer')
  modelCache.require('Suggestion')
  modelCache.require('Ping')
  modelCache.require('TripStatus')
  modelCache.require('Alert')
  modelCache.require('Asset')
  modelCache.require('TripTicket')
  modelCache.require('AdminCompany')
  modelCache.require('DriverCompany')
  modelCache.require('Subscription')
  modelCache.require('IndicativeTrip')
  modelCache.require('EventSubscription')
  modelCache.require('Credit')
  modelCache.require('RouteCredit')
  modelCache.require('RoutePass')
  modelCache.require('TripDriver')
  modelCache.require('ReferralCredit')
  modelCache.require('PromoUsage')
  modelCache.require('ContactList')
  modelCache.require('Bid')
  modelCache.require('UserSuggestedRoute')
  modelCache.require('UserSuggestedRouteStop')


  modelCache.makeAssociations()
  return modelCache
}

function dbLogin () {
  // Grab the config parameters
  var sequelizeOptions = _.extend({}, config.sequelizeOptions, {
    logging: process.env.SHUTUP ? false : console.log,
  })

  // Throw an error if we don't have a databse url to connect to
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environmental variable not set")
  }

  // Creates the database connection and test it
  var sequelize = new Sequelize(process.env.DATABASE_URL, sequelizeOptions)
  sequelize
    .authenticate()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  return sequelize
}
