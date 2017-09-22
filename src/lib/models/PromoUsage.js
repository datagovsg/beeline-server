import assert from 'assert'
import _ from 'lodash'
import Joi from "joi"

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize

  return modelCache.db.define('promoUsage', {
    userId: { type: DataTypes.INTEGER, allowNull: true },
    promoId: { type: DataTypes.INTEGER },
    count: { type: DataTypes.INTEGER },
  }, {
    indexes: [
      { fields: ['userId', 'promoId'], unique: true}
    ],

    classMethods: {
      // get number of tickets a promotion has been applied to across users
      // creates an entry if it doesn't exist
      // @param: promoId - id of promotion, from promotion table
      // @returns: integer - sum of all uses of a promo by users
      getGlobalPromoUsage (promoId, options) {
        return this.findOrCreate(_.defaults({
          defaults: { promoId, userId: null, count: 0 },
          where: { promoId, userId: null }
        }, options)).then(([inst, isCreated]) => inst.count)
      },
      // get number of tickets a promotion has been applied to for a user
      // creates an entry if it doesn't exist
      // @param: promoId - id of promotion, from promotion table
      // @param: userId - id of user, from user table
      // @returns: integer - count of times a promotion has been applied to tickets purchased by user
      getUserPromoUsage (promoId, userId, options) {
        return this.findOrCreate(_.defaults({
          defaults: { promoId, userId, count: 0 },
          where: { promoId, userId }
        }, options)).then(([inst, isCreated]) => inst.count)
      },
      // called when a transaction is completed,
      // increments count based on how many tickets a promotion is applied to in a purchase
      // creates an entry if it doesn't exist
      // @param: promoId - id of promotion, from promotion table
      // @param: userId - id of user, from user table
      // @params: amount - INTEGER: amount to increment by
      addUserPromoUsage (promoId, userId, amount, options) {
        assert(isFinite(promoId))
        assert(isFinite(userId))
        assert(isFinite(amount))

        return this.findOrCreate(_.defaults({
          defaults: { promoId, userId, count: 0 },
          where: { userId, promoId },
        }, options)).then(([inst, isCreated]) => {
          assert(amount >= 0)
          return inst.increment('count', _.defaults({ by: amount }, options))
        })
      },
      // for refund - reverse increment
      subtractUserPromoUsage (promoId, userId, amount, options) {
        assert(isFinite(promoId))
        assert(isFinite(userId))
        assert(isFinite(amount))

        return this.find({ where: { userId, promoId }}, options)
          .then(inst => {
            assert(inst.count >= amount)
            assert(amount >= 0)
            return inst.decrement('count', _.defaults({by: amount}, options))
          })
      },
      // Updates total counter when a purchase is complete
      async addGlobalPromoUsage (promoId, amount, options) {
        assert(isFinite(promoId))
        assert(isFinite(amount))

        return this.findOrCreate(_.defaults({
          defaults: { promoId, userId: null, count: 0 },
          where: { promoId, userId: null }
        }, options)).then(([inst, isCreated]) => {
          assert(amount >= 0)
          return inst.increment('count', _.defaults({by: amount}, options))
        })
      },

      async subtractGlobalPromoUsage (promoId, amount, options) {
        assert(isFinite(promoId))
        assert(isFinite(amount))

        return this.find({ where: { promoId, userId: null }}, options)
          .then((inst) => {
            assert(inst.count >= amount)
            assert(amount >= 0)
            return inst.decrement('count', _.defaults({by: amount}, options))
          })
      },
    }
  })
}

export function makeAssociation (modelCache) {
  var PromoUsage = modelCache.require('PromoUsage')
  var Promotion = modelCache.require('Promotion')
  var User = modelCache.require('User')

  PromoUsage.belongsTo(User, {
    foreignKey: "userId"
  })

  PromoUsage.belongsTo(Promotion, {
    foreignKey: "promoId"
  })
}
