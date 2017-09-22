import * as auth from "../core/auth"
import assert from 'assert'
import _ from 'lodash'
import Joi from "joi"
import { TransactionBuilder } from '../transactions/builder'

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  var db = modelCache.db

  return modelCache.db.define('credit', {
    userId: {
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: '0.00',
    }
  },
    {
      classMethods: {
        get (userId, options) {
          return this.findOrCreate(_.defaults({
            raw: true,
            where: {userId},
            defaults: {userId}
          }, options))
          .then(([inst, isCreated]) => inst)
        },
        getUserCredits (userId, options) {
          return this.findOrCreate(_.defaults({
            raw: true,
            where: {userId},
            defaults: {userId},
          }, options))
          .then(([inst, isCreated]) => inst.balance)
        },
        addUserCredits (userId, amount, options) {
          assert(isFinite(userId))
          assert(isFinite(amount))

          return this.findOrCreate(_.defaults({
            defaults: {userId: userId, balance: 0.0},
            where: {userId: userId},
          }, options)).then(([inst, isCreated]) => {
            assert(parseFloat(inst.balance) >= -parseFloat(amount))
            return inst.increment('balance', _.defaults({by: amount}, options))
          })
        },
        subtractUserCredits (userId, amount, options) {
          assert(isFinite(userId))
          assert(isFinite(amount))

          return this.findById(userId, options)
          .then(inst => {
            assert(parseFloat(inst.balance) + 0.0001 >= parseFloat(amount))
            return inst.decrement('balance', _.defaults({by: amount}, options))
          })
        },
      // Method handling operations between a user credit account and
      // the main "Cost of Goods Sold" account. Creates transaction
      // and transactionItem entry.
      // from: {itemType: 'account' or 'userCredit', itemId: accountId or userId respectively}
      // to: {itemType: 'account' or 'userCredit', itemId: accountId or userId respectively}
      // amount: amount to add or deduct
      // accTxn: contains details like the description and creator of the transaction
      // options: contains db transaction. Initialise as object if not assigned a value
      // tb: transactionBuilder - {db, transaction, models, dryRun, committed, description, transactionItemsByType}
      // Returns tb object with transactionItems describing the distribution of credits
      //
      // userCredit accounts are considered liability accounts (credit)
      // credits are drawn from our expense account (debit)
        async moveCredits (from, to, amount, tb) {
        // check input
          Joi.assert(from, Joi.object().keys({
            itemType: Joi.string().required().valid(['account', 'userCredit']),
            itemId: Joi.number().integer().required()
          }))
          Joi.assert(to, Joi.object().keys({
            itemType: Joi.string().required().valid(['account', 'userCredit']),
            itemId: Joi.number().integer().required()
          }))
          Joi.assert(amount, Joi.number().required())
          Joi.assert(tb, Joi.object())

          let clone = new TransactionBuilder(tb)
          clone.transactionItemsByType.userCredit = clone.transactionItemsByType.userCredit || []
          clone.transactionItemsByType.account = clone.transactionItemsByType.account || []

          let fromTransactionItem = _.defaults({debit: amount}, from)
          let toTransactionItem = _.defaults({credit: amount}, to)

          if (fromTransactionItem.itemType === 'userCredit') {
            await this.subtractUserCredits(fromTransactionItem.itemId, amount, {transaction: clone.transaction})
            clone.transactionItemsByType.userCredit.push(fromTransactionItem)
            clone.transactionItemsByType.account.push(toTransactionItem)
          }
          if (toTransactionItem.itemType === 'userCredit') {
            await this.addUserCredits(toTransactionItem.itemId, amount, {transaction: clone.transaction})
            clone.transactionItemsByType.userCredit.push(toTransactionItem)
            clone.transactionItemsByType.account.push(fromTransactionItem)
          }

          return clone
        }
      },
    })
}

export function makeAssociation (modelCache) {
  var Credit = modelCache.require('Credit')
  var TransactionItem = modelCache.require('TransactionItem')
  var User = modelCache.require('User')

  Credit.hasMany(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: {
        $in: ["userCredit"]
      }
    }
  })

  Credit.belongsTo(User, {
    foreignKey: "userId"
  })
}
