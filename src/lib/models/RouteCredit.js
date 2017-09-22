import * as auth from "../core/auth"
import assert from 'assert'
import _ from 'lodash'

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  var db = modelCache.db

  return modelCache.db.define('routeCredit', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
    },
    tag: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: '0.00',
    }
  },
    {
      indexes: [
      {fields: ['userId', 'companyId', 'tag'], unique: true},
      {fields: ['companyId', 'userId']}
      ],
      classMethods: {
        get (userId, companyId, tag, options) {
          assert(userId && tag && companyId)
          return this.findOrCreate(_.defaults({
            where: {userId, tag, companyId},
            defaults: {userId, tag, companyId, balance: 0}
          }, options))
        .then(([inst, isCreated]) => inst)
        },
      /* Doesn't create the entry unless it is necessary */
        getUserCredits (userId, companyId, tag, options) {
          assert(userId && tag && companyId)
          return this.findOne(_.defaults({
            where: {userId, tag, companyId},
          }, options))
          .then(inst => inst ? inst.balance : '0.00')
        },
        addUserCredits (userId, companyId, tag, amount, options) {
          assert(isFinite(amount))

          return this.get(userId, companyId, tag, options)
          .then(inst => {
            assert(parseFloat(inst.balance) >= -parseFloat(amount))

            return inst.increment('balance', _.defaults({by: amount}, options))
            .then(() => inst)
          })
        },
        subtractUserCredits (userId, companyId, tag, amount, options) {
          assert(isFinite(amount))

          return this.get(userId, companyId, tag, options)
          .then(inst => {
            assert(parseFloat(inst.balance) + 0.0001 >= parseFloat(amount))
            return inst.decrement('balance', _.defaults({by: amount}, options))
          })
        },
      },
    })
}

export function makeAssociation (modelCache) {
  var User = modelCache.require('User')
  var RouteCredit = modelCache.require('RouteCredit')
  var TransportCompany = modelCache.require('TransportCompany')
  var TransactionItem = modelCache.require('TransactionItem')
  RouteCredit.belongsTo(User, {
    foreignKey: "userId"
  })
  RouteCredit.belongsTo(TransportCompany, {
    foreignKey: "companyId"
  })
  RouteCredit.hasMany(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: {
        $in: ["routeCredits"]
      }
    }
  })
}
