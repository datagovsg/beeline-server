import assert from 'assert'
import _ from "lodash"
import leftPad from 'left-pad'
import seedrandom from "seedrandom"
import * as sms from "../util/sms"
import * as onesignal from "../util/onesignal"
const Joi = require('../util/joi')

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('trip', {
    date: DataTypes.DATEONLY,

    capacity: DataTypes.INTEGER,
    seatsAvailable: DataTypes.INTEGER,

    /**
     * Reflects seat availability derived from
     * the capacity and seatsAvailable properties
     * Used largely for backward-compatibility
     */
    availability: {
      type: new DataTypes.VIRTUAL(DataTypes.JSON, ['seatsAvailable', 'capacity']),
      get: function () {
        return {
          seatsAvailable: this.getDataValue("seatsAvailable"),
          seatsTotal: this.getDataValue("capacity"),
          seatsBooked: this.getDataValue("capacity") - this.getDataValue("seatsAvailable"),
        }
      }
    },

    price: DataTypes.DECIMAL(10, 2),
    priceF: {
      type: DataTypes.VIRTUAL,
      set: function (val) {
        this.setDataValue("price", val)
      },
      get: function () {
        var v = this.getDataValue("price")
        return (v == null) ? null : parseFloat(v)
      },
    },

    status: DataTypes.STRING(20),
    isRunning: {
      type: DataTypes.VIRTUAL,
      get (val) {
        var v = this.getDataValue('status')
        return !(v === 'cancelled' || v === 'void')
      }
    },

    vehicleId: {
      type: DataTypes.INTEGER,
    },

    driverId: {
      type: DataTypes.INTEGER,
    },

    routeId: {
      type: DataTypes.INTEGER,
    },

    /**
     * Window determined by the stop times
     * Cuts off 10mins before bus arrives at stop
     * {
     *   windowType: 'stop',
     *   windowSize: -60000
     * }
     *
     * Window determined by the first stop time of trip
     * Cuts off at 0 mins
     * {
     *   windowType: 'firstStop'
     *   windowSize: 0
     * }
     * Notes:
     * {
     *   notes: 'Donald Duck will be joining you on this trip'
     * }
     */
    bookingInfo: {
      type: DataTypes.JSON,
    },
  },
  {
    hooks: {
      beforeCreate: function (trip, options) {
        if (trip.seatsAvailable == null) {
          trip.seatsAvailable = trip.capacity
        }
      },
    },
    indexes: [
      {fields: ["vehicleId"]},
      {fields: ["driverId"]},
      {fields: ["routeId", "date"]}
    ],
    classMethods: {
      getForTransactionChecks (options) {
        assert(options.tripIds instanceof Array)

        return this.findAll({
          where: {
            id: {
              $in: options.tripIds
            }
          },
          include: [
            {
              model: modelCache.require('TripStop'),
              include: [
                modelCache.models.Ticket
              ]
            },
            {
              model: modelCache.require('Route'),
              attributes: ['transportCompanyId'],
            }
          ],
          transaction: options.transaction
        }).then((trips) => {
          return _.keyBy(trips.map(x => x.toJSON()), x => x.id)
        })
      }
    },
    instanceMethods: {
      /* Returns the trip code. Will check the date if specified */
      getCode (checkDate = false) {
        if (checkDate) {
          var now = Date.now()
          var runDate = this.date

          if (runDate && runDate.getTime() - 8 * 60 * 60 * 1000 > now) {
            return null
          }
        }

        var rng = seedrandom(`${process.env.BEELINE_RANDOM_SEED}-${runDate.getTime()}-${this.id}`)

        return leftPad(Math.floor(rng() * 10000), 4, "0")
      },

      getPassengers () {
        return modelCache.models.User.findAll({
          include: [
            {
              model: modelCache.models.Ticket,
              where: { status: 'valid' },
              include: [
                {
                  model: modelCache.models.TripStop,
                  as: 'boardStop',
                  where: { tripId: this.id },
                },
              ],
            },
          ],
        })
      },

      async getPassengerTelephones () {
        var passengers = await this.getPassengers()
        const telephoneSchema = Joi.string().telephone()
        var telephones = passengers
          .map((p) => { // extract telephone numbers
            if (p.telephone) return p.telephone

            try { // For WRS customers, the telephone may be encoded in the JSON
              var json = JSON.parse(p.name)
              return json.telephone
            } catch (err) {
              return null
            }
          })
          .map((tel) => { // validate them
            try {
              return Joi.attempt(tel, telephoneSchema)
            } catch (err) {
              return null
            }
          })

        // don't send the same message twice
        return _.uniq(telephones)
      },

      /**
       * Messages passengers who hold tickets on this trip
       * @param body -- message body
       * @param options
       *    @prop sendToAdmins : boolean -- whether to message admins
       *    @prop sender : string -- the sender of the message (e.g. email address of admin)
       *    @prop ccDetail : string -- additional information for those on the list
       */
      async messagePassengers (body, options) {
        return Promise.all([
          this.messagePassengersByOneSignal(body, options),
          this.messagePassengersBySMS(body, options),
          this.messagePassengersNotifyAdmin(body, options),
        ])
      },

      async messagePassengersByOneSignal (body, options) {
        const passengers = await this.getPassengers()
        const onesignalTags = passengers.map(p => _.get(p, 'notes.pushNotificationTag'))

        return onesignalTags.filter(x => x).map(tag =>
          onesignal.createNotification({
            contents: {
              en: body,
            },
            headings: {
              en: 'Beeline'
            },
            filters: [
              {filter: 'tag', key: 'user_tag', relation: '=', value: tag}
            ]
          }).catch(() => {})
        )
      },

      async messagePassengersNotifyAdmin (body, options) {
        const smsFunc = x => sms.sendSMS(x).catch((err) => {})

        // defaults:
        const notifyOptions = {
          sendToAdmins: true,
          sender: '(anonymous)',
          ccDetail: '',
          ...options,
        }

        // drop a notification to our admins
        if (notifyOptions.sendToAdmins) {
          // get time and creator
          var creator = notifyOptions.sender
          var now = new Date()
          var time = leftPad(now.getHours(), 2, '0') + ':' + leftPad(now.getMinutes(), 2, '0')
          var route = await modelCache.models.Route.findById(this.routeId)

          var ccRecipients = await modelCache.models.Admin.allToAlertFromCompany(route.transportCompanyId)
          var messageToAdmins = `${body}\nSent by ${creator} at ${time}`
          if (notifyOptions.ccDetail) {
            messageToAdmins += `, ${notifyOptions.ccDetail}`
          }

          return Promise.all(ccRecipients.map((admin) => {
            return smsFunc({
              from: 'BeelineOps',
              to: admin.telephone,
              body: messageToAdmins
            })
          }))
        }
      },

      async messagePassengersBySMS (body, smsOptions) {
        const smsFunc = x => sms.sendSMS(x).catch((err) => {})

        // get list of passengers
        var telephones = await this.getPassengerTelephones()

        // don't send the same message twice -- e.g. WRS
        telephones = _.uniq(telephones)

        var route = await modelCache.models.Route.findById(this.routeId)
        
        var transportCompany =
          await modelCache.models.TransportCompany.findById(
            route.transportCompanyId, { attributes: ['smsOpCode'] })

        // send out the message
        var sendMessagePromises = telephones.map((tel) => smsFunc({
          from: transportCompany.smsOpCode || 'BeelineSG',
          to: tel,
          body: body,
        }))

        await Promise.all(sendMessagePromises)

        return telephones.length
      }
    }
  })
}

export function makeAssociation (modelCache) {
  var Trip = modelCache.require('Trip')
  var TripStop = modelCache.require('TripStop')
  var TripTicket = modelCache.require('TripTicket')
  var TripStatus = modelCache.require('TripStatus')
  var Ping = modelCache.require('Ping')
  var Driver = modelCache.require('Driver')
  var Route = modelCache.require('Route')
  var Vehicle = modelCache.require('Vehicle')
  Trip.hasMany(TripStop, {
    foreignKey: "tripId",
    onDelete: "CASCADE"
  })
  Trip.hasMany(TripTicket, {
    foreignKey: "tripId"
  })
  // Trip, ping statuses
  Trip.hasMany(TripStatus, {
    foreignKey: "tripId"
  })
  Trip.hasMany(Ping, {
    foreignKey: "tripId"
  })
  Trip.belongsTo(Driver, {
    foreignKey: "driverId"
  })
  Trip.belongsTo(Route, {
    foreignKey: "routeId"
  })
  Trip.belongsTo(Vehicle, {
    foreignKey: "vehicleId"
  })
}
