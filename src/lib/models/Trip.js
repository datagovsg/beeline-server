/* eslint-disable new-cap */

import assert from "assert"
import _ from "lodash"
import leftPad from "left-pad"
import seedrandom from "seedrandom"
import * as sms from "../util/sms"
import * as onesignal from "../util/onesignal"
const Joi = require("../util/joi")

export default modelCache => {
  const DataTypes = modelCache.db.Sequelize
  return modelCache.db.define(
    "trip",
    {
      date: DataTypes.DATEONLY,

      capacity: DataTypes.INTEGER,
      seatsAvailable: DataTypes.INTEGER,

      /**
       * Reflects seat availability derived from
       * the capacity and seatsAvailable properties
       * Used largely for backward-compatibility
       */
      availability: {
        type: new DataTypes.VIRTUAL(DataTypes.JSON, [
          "seatsAvailable",
          "capacity",
        ]),
        get: function() {
          return {
            seatsAvailable: this.getDataValue("seatsAvailable"),
            seatsTotal: this.getDataValue("capacity"),
            seatsBooked:
              this.getDataValue("capacity") -
              this.getDataValue("seatsAvailable"),
          }
        },
      },

      price: DataTypes.DECIMAL(10, 2),
      priceF: {
        type: DataTypes.VIRTUAL,
        set: function(val) {
          this.setDataValue("price", val)
        },
        get: function() {
          const v = this.getDataValue("price")
          return v == null ? null : parseFloat(v)
        },
      },

      status: DataTypes.STRING(20),
      messages: {
        type: DataTypes.ARRAY(DataTypes.JSONB),
        defaultValue: [],
      },
      isRunning: {
        type: DataTypes.VIRTUAL,
        get(val) {
          const v = this.getDataValue("status")
          return !(v === "cancelled" || v === "void")
        },
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
        set(val) {
          Joi.assert(
            val,
            Joi.object({
              windowType: Joi.string()
                .valid(["stop", "firstStop"])
                .default("stop"),
              windowSize: Joi.number()
                .integer()
                .default(-300000),
              notes: Joi.string()
                .allow("")
                .allow(null)
                .default(null),
              childTicketPrice: Joi.number().allow(null),
            })
              .optional()
              .allow(null)
          )
          this.setDataValue("bookingInfo", val)
        },
      },
    },
    {
      hooks: {
        beforeCreate: function(trip, options) {
          if (trip.seatsAvailable == null) {
            trip.seatsAvailable = trip.capacity
          }
        },
      },
      indexes: [
        { fields: ["vehicleId"] },
        { fields: ["driverId"] },
        { fields: ["routeId", "date"] },
      ],
      classMethods: {
        getForTransactionChecks(options) {
          assert(options.tripIds instanceof Array)

          return this.findAll({
            where: {
              id: {
                $in: options.tripIds,
              },
            },
            include: [
              {
                model: modelCache.require("TripStop"),
                include: [modelCache.models.Ticket],
              },
              {
                model: modelCache.require("Route"),
                attributes: ["transportCompanyId"],
              },
            ],
            transaction: options.transaction,
          }).then(trips => {
            return _.keyBy(trips.map(x => x.toJSON()), x => x.id)
          })
        },
      },
      instanceMethods: {
        /* Returns the trip code. Will check the date if specified */
        getCode(checkDate = false) {
          const runDate = this.date
          if (checkDate) {
            const now = Date.now()
            if (runDate && runDate.getTime() - 8 * 60 * 60 * 1000 > now) {
              return null
            }
          }

          const rng = seedrandom(
            `${process.env.BEELINE_RANDOM_SEED}-${runDate.getTime()}-${this.id}`
          )

          return leftPad(Math.floor(rng() * 10000), 4, "0")
        },

        getPassengers() {
          return modelCache.models.User.findAll({
            include: [
              {
                model: modelCache.models.Ticket,
                where: { status: "valid" },
                include: [
                  {
                    model: modelCache.models.TripStop,
                    as: "boardStop",
                    where: { tripId: this.id },
                  },
                ],
              },
            ],
          })
        },

        async getPassengerTelephones() {
          const passengers = await this.getPassengers()
          const telephoneSchema = Joi.string().telephone()
          const telephones = passengers
            .map(p => {
              // extract telephone numbers
              if (p.telephone) return p.telephone

              try {
                // For WRS customers, the telephone may be encoded in the JSON
                const json = JSON.parse(p.name)
                return json.telephone
              } catch (err) {
                return null
              }
            })
            .map(tel => {
              // validate them
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
         * @param {string} body -- message body
         * @param {object} options
         *   sendToAdmins : boolean -- whether to message admins
         *   sender : string -- the sender of the message (e.g. email address of admin)
         *   ccDetail : string -- additional information for those on the list
         * @return {Promise} a Promise that blocks on messaging passengers over
         * the various channels
         */
        async messagePassengers(body, options) {
          return Promise.all([
            this.messagePassengersByOneSignal(body, options),
            this.messagePassengersBySMS(body, options),
            this.messagePassengersNotifyAdmin(body, options),
          ])
        },

        async messagePassengersByOneSignal(body, options) {
          const passengers = await this.getPassengers()
          const onesignalTags = passengers.map(p =>
            _.get(p, "notes.pushNotificationTag")
          )

          return onesignalTags.filter(x => x).map(tag =>
            onesignal
              .createNotification({
                contents: {
                  en: body,
                },
                headings: {
                  en: "Beeline",
                },
                filters: [
                  { field: "tag", key: "user_tag", relation: "=", value: tag },
                ],
              })
              .catch(err => {
                console.error(err)
              })
          )
        },

        async messagePassengersNotifyAdmin(body, options) {
          const smsFunc = x =>
            sms.sendSMS(x).catch(err => {
              console.error(err)
            })

          // defaults:
          const notifyOptions = {
            sendToAdmins: true,
            sender: "(anonymous)",
            ccDetail: "",
            ...options,
          }

          // drop a notification to our admins
          if (notifyOptions.sendToAdmins) {
            // get time and creator
            const creator = notifyOptions.sender
            const now = new Date()
            const time =
              leftPad(now.getHours(), 2, "0") +
              ":" +
              leftPad(now.getMinutes(), 2, "0")
            const route = await modelCache.models.Route.findById(this.routeId)

            const ccRecipients = await modelCache.models.Admin.allToAlertFromCompany(
              route.transportCompanyId
            )
            let messageToAdmins = `${body}\nSent by ${creator} at ${time}`
            if (notifyOptions.ccDetail) {
              messageToAdmins += `, ${notifyOptions.ccDetail}`
            }

            return Promise.all(
              ccRecipients.map(admin => {
                return smsFunc({
                  from: "BeelineOps",
                  to: admin.telephone,
                  body: messageToAdmins,
                })
              })
            )
          }
        },

        async messagePassengersBySMS(body, smsOptions) {
          const smsFunc = x =>
            sms.sendSMS(x).catch(err => {
              console.error(err)
            })

          // get list of passengers
          let telephones = await this.getPassengerTelephones()

          // don't send the same message twice -- e.g. WRS
          telephones = _.uniq(telephones)

          const route = await modelCache.models.Route.findById(this.routeId)

          const transportCompany = await modelCache.models.TransportCompany.findById(
            route.transportCompanyId,
            { attributes: ["smsOpCode"] }
          )

          // send out the message
          const sendMessagePromises = telephones.map(tel =>
            smsFunc({
              from: transportCompany.smsOpCode || "BeelineSG",
              to: tel,
              body: body,
            })
          )

          await Promise.all(sendMessagePromises)

          return telephones.length
        },
      },
    }
  )
}

export const makeAssociation = modelCache => {
  const Trip = modelCache.require("Trip")
  const TripStop = modelCache.require("TripStop")
  const TripStatus = modelCache.require("TripStatus")
  const Driver = modelCache.require("Driver")
  const Route = modelCache.require("Route")
  const Vehicle = modelCache.require("Vehicle")
  Trip.hasMany(TripStop, {
    foreignKey: "tripId",
    onDelete: "CASCADE",
  })
  // Trip, ping statuses
  Trip.hasMany(TripStatus, {
    foreignKey: "tripId",
  })
  Trip.belongsTo(Driver, {
    foreignKey: "driverId",
  })
  Trip.belongsTo(Route, {
    foreignKey: "routeId",
  })
  Trip.belongsTo(Vehicle, {
    foreignKey: "vehicleId",
  })
}
