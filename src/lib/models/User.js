import assert from 'assert'
import * as auth from '../core/auth'
import * as onesignal from '../util/onesignal.js'
import ssaclAttributeRoles from 'ssacl-attribute-roles'
const _ = require("lodash")

export default function (modelCache) {
  var m = modelCache.models
  var DataTypes = modelCache.db.Sequelize
  var db = modelCache.db
  var model = modelCache.db.define('user', {
    email: {
      type: DataTypes.STRING,
      allowNull: true
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
      unique: true
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: true, /* if null, the only way of logging in is by SSO */
      roles: false
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
    type: DataTypes.STRING(10), /* What should this mean? "TRANSIENT" / "REGISTERED" ? */
    status: DataTypes.STRING,
    lastComms: DataTypes.DATE,
    lastLogin: DataTypes.DATE,
    refCodeId: DataTypes.INTEGER,
    referrerId: DataTypes.INTEGER,
    notes: DataTypes.JSONB,
    savedPaymentInfo: DataTypes.JSONB,
    lastUsedAppName: DataTypes.STRING
  },
  {
    instanceMethods: {
      // REFERRAL CODES
      // ==============

      // Returns boolean value indicating if the user is eligible to use referral codes
      // SIDE EFFECT: Assigns own id as referrer id if they have had previous purchases
      // Performs the following checks:
      // 1. User was not referred before (referrerId != null)
      // 2. User has not purchased tickets before
      // Input:
      // options - {transaction: sequelize transaction}
      async isEligibleForReferralProgram (options = {}) {
      // not eligible if it has referrer id
        if (this.referrerId) {
          return false
        }

        // if it doesn't, check if user has done a previous purchase
        var hasPreviousPurchase = ((await m.Ticket.findAll(
          { where: {
            status: 'valid',
            userId: this.id.toString()
          },
          include: [{model: m.TransactionItem, where: {itemType: 'ticketSale'}}],
          transaction: options.transaction,
          })).length > 0)

        // assign their own id as referrer id if there are purchases
        // NOTE: this is a way to mark these users as not eligible for referral program
        if (hasPreviousPurchase) {
          this.referrerId = this.id
          await this.save({transaction: options.transaction})
        }

        // eligble if they have not had previous purchases
        return !hasPreviousPurchase
      },
      // Save referral codes keyed in / used via referral link by User
      // Input:
      // - refCode: String - referral code to be used
      // - refCodeOwner: Object
      //   - referrerId: Number - id of owner of refCode
      //   - name: String - name of owner of refCode
      // Output: none
      async saveRefCode (refCode, refCodeOwner) {
      // Changed code enforces only 1 referral code will be saved for the user

        if (!this.notes) { this.notes = {} }
        // if(!this.notes.savedRefCodes) { this.notes.savedRefCodes = {} }

        this.notes = _.clone(this.notes)
        this.notes.savedRefCodes = {}
        this.notes.savedRefCodes[refCode] = refCodeOwner

        await this.save()
      },
      // Retrieves list of all saved refCodes and corresponding owner data
      // Output - Obj {refCode: refCodeOwner}
      getSavedRefCode () {
        if (!this.notes || !this.notes.savedRefCodes) { return {} }

        return this.notes.savedRefCodes
      },
      makeToken (iat) {
        return auth.signSession({
          role: "user",
          userId: this.id,
          iat: Math.floor((iat || Date.now()) / 1000)
        })
      },

      /**
       * Sends a notification to a user via OneSignal
       *
       * The user *must* have a notification tag, else
       * this function will throw an error
       * @param {title: String, message: String} param0
       */
      sendNotification ({title, message}) {
        assert(this.notes && this.notes.pushNotificationTag)

        return onesignal.createNotification({
          contents: {
            en: message,
          },
          headings: {
            en: title,
          },
          filters: [
            {field: 'tag', key: 'user_tag', relation: '=', value: this.notes.pushNotificationTag}
          ]
        })
      },

      canSendNotification () {
        return _.get(this.notes, 'pushNotificationTag')
      },

      // Create refCode in the promotion table
      // Benefits are hardcoded in this function
      // RETURN: instance of the refCode from promotion table
      async generateRefCode (options = {}) {
        if (!options.transaction) {
          return db.transaction(
            { isolationLevel: db.Transaction.ISOLATION_LEVELS.SERIALIZABLE },
            t => realGenerateRefCode(this, t)
          )
        } else {
          return realGenerateRefCode(this, options.transaction)
        }

        async function realGenerateRefCode (user, transaction) {
          // define benefits
          const discountRate = 0
          const creditAmt = 10

          var refCode, refCodeInst

          // generate a refCode and check for refCode collision
          do {
            refCode = m.User.makeRefCode()
          } while ((await m.Promotion.findAll({where: {code: refCode}})).length > 0) // eslint-disable-line no-await-in-loop

          // create refCode entry in promotions
          refCodeInst = await m.Promotion.create({
            code: refCode,
            type: 'Referral',
            description: 'Referral',
            params: {
              discountFunction: {
                type: 'simpleRate',
                params: {
                  rate: discountRate
                }
              },
              refundFunction: {
                type: 'refundDiscountedAmt',
                params: {
                }
              },
              qualifyingCriteria: [{
                type: 'noLimit',
                params: {}
              }],
              creditAmt: creditAmt,
              ownerId: user.id
            }
          }, {transaction: transaction})

          user.refCodeId = refCodeInst.id
          await user.save({transaction: transaction})

          return refCodeInst
        }
      },
    },
    classMethods: {
      // Returns a 6 character alphanumeric string (uppercase only) to be used as referral codes.
      // The string is generated by multiplying a random float (0 <= x < 1) with 2^31,
      // then converting the floor of the resulting number into a string (base 36), padding the
      // start of the string with 0s should it fall below the intended length.
      makeRefCode () {
        const refCodeLength = 6
        var refCode = Math.floor(Math.random() * ~(1 << 31)).toString(36).toUpperCase()
        if (refCode.length !== refCodeLength) { refCode = _.padStart(refCode, refCodeLength, '0') }
        return refCode
      },
    },
    hooks: {
      beforeUpdate (instance, options) {
        if (instance._previousDataValues.email !== instance.dataValues.email) {
          instance.emailVerified = false
        }
      }
    }
  })

  ssaclAttributeRoles(model)
  return model
}

export function makeAssociation (modelCache) {
  var User = modelCache.require('User')
  var Ticket = modelCache.require('Ticket')
  User.hasMany(Ticket, {
    foreignKey: "userId",
  })

  User.belongsTo(modelCache.models.Promotion, {
    foreignKey: "refCodeId",
    as: "referralCode",
    constraints: false
  })

  User.belongsTo(User, {
    foreignKey: 'referrerId',
    as: 'referrer',
    constraints: false
  })
}
