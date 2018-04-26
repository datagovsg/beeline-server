import assert from "assert"
import * as auth from "../core/auth"
import * as onesignal from "../util/onesignal.js"
import ssaclAttributeRoles from "ssacl-attribute-roles"
import { stripe } from "../transactions/payment"
const _ = require("lodash")

/**
 * @param {object} modelCache - the dictionary containing Sequelize models
 * @return {object} the User Sequelize model as defined here
 */
export default function(modelCache) {
  let DataTypes = modelCache.db.Sequelize
  let model = modelCache.db.define(
    "user",
    {
      email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      emailVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      name: DataTypes.TEXT,
      telephone: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
      },
      passwordHash: {
        type: DataTypes.STRING,
        allowNull: true /* if null, the only way of logging in is by SSO */,
        roles: false,
      },
      password: {
        type: DataTypes.VIRTUAL,
        set: () => null,
        get: () => null,
        roles: false,
      },
      telephoneCode: {
        type: DataTypes.STRING,
        roles: false,
      },
      /* What should `type` mean? "TRANSIENT" / "REGISTERED" ? */
      type: DataTypes.STRING(10), // eslint-disable-line new-cap
      status: DataTypes.STRING,
      lastComms: DataTypes.DATE,
      lastLogin: DataTypes.DATE,
      notes: DataTypes.JSONB,
      savedPaymentInfo: DataTypes.JSONB,
      lastUsedAppName: DataTypes.STRING,
    },
    {
      instanceMethods: {
        makeToken(iat) {
          return auth.signSession({
            role: "user",
            userId: this.id,
            iat: Math.floor((iat || Date.now()) / 1000),
          })
        },

        /**
         * Sends a notification to a user via OneSignal
         *
         * The user *must* have a notification tag, else
         * this function will throw an error
         * @param {string} title - the title of the notification
         * @param {string} message - the message payload
         * @return {*} the output from `onesignal.createNotification`
         */
        sendNotification({ title, message }) {
          assert(this.notes && this.notes.pushNotificationTag)

          return onesignal.createNotification({
            contents: {
              en: message,
            },
            headings: {
              en: title,
            },
            filters: [
              {
                field: "tag",
                key: "user_tag",
                relation: "=",
                value: this.notes.pushNotificationTag,
              },
            ],
          })
        },

        canSendNotification() {
          return _.get(this.notes, "pushNotificationTag")
        },

        async getOrCreatePaymentInfo() {
          if (this.savedPaymentInfo) {
            return this.savedPaymentInfo
          } else {
            const customerInfo = await stripe.customers.create({
              metadata: {
                userId: this.id,
              },
            })

            this.savedPaymentInfo = customerInfo
            return customerInfo
          }
        },

        async refreshPaymentInfo() {
          const customerInfo = await stripe.customers.retrieve(
            this.savedPaymentInfo.id
          )

          this.savedPaymentInfo = customerInfo
          return customerInfo
        },

        async addPaymentSource(stripeToken) {
          const paymentInfo = await this.getOrCreatePaymentInfo()

          // FIXME support more than 10 credit cards
          // Return the list of credit cards...
          await stripe.customers.createSource(paymentInfo.id, {
            source: stripeToken,
          })

          return this.refreshPaymentInfo()
        },
      },
      hooks: {
        beforeUpdate(instance, options) {
          if (
            instance._previousDataValues.email !== instance.dataValues.email
          ) {
            instance.emailVerified = false
          }
        },
      },
    }
  )

  ssaclAttributeRoles(model)
  return model
}

/**
 * Associate User with Tickets
 * @param {object} modelCache - the dictionary containing Sequelize models
 */
export function makeAssociation(modelCache) {
  let User = modelCache.require("User")
  let Ticket = modelCache.require("Ticket")
  User.hasMany(Ticket, {
    foreignKey: "userId",
  })
}
