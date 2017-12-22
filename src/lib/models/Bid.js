import _ from 'lodash'
import {InvalidArgumentError, TransactionError, ChargeError} from "../util/errors"

export default function (modelCache) {
  const VOID_STATUSES = ['void', 'withdrawn', 'failed']
  const VALID_STATUSES = ['pending', 'bidded']
  const STATUSES = VOID_STATUSES.concat(VALID_STATUSES)

  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('bid', {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [STATUSES],
          msg: 'Must be one of ' + STATUSES,
        }
      },
      allowNull: false,
    },
    price: {
      type: DataTypes.DECIMAL(10, 2), // eslint-disable-line babel/new-cap
      allowNull: false,
    },
    priceF: {
      type: DataTypes.VIRTUAL,
      set: function (val) {
        this.setDataValue('price', val)
      },
      get: function () {
        const v = this.getDataValue('price')
        return (v == null) ? null : parseFloat(v)
      },
    },
    notes: DataTypes.JSONB
  }, {
    indexes: [
      {fields: ["userId"]},
      {fields: ["routeId"]}
    ],

    classMethods: {
      async createForUserAndRoute (userInst, routeInst, price, options = {}) {
        const m = modelCache.models

        // User must first have saved his card details
        ChargeError.assert(
          userInst.savedPaymentInfo && userInst.savedPaymentInfo.default_source,
          "You need to provide payment information.")
        TransactionError.assert(
          routeInst.tags.includes('crowdstart'),
          'Selected route is not a crowdstart route')

        const crowdstartExpiry = _.get(routeInst, 'notes.crowdstartExpiry')
        const isOpenForBids = !crowdstartExpiry ||
          Date.now() < new Date(crowdstartExpiry).getTime()

        TransactionError.assert(
          isOpenForBids,
          'Selected route is no longer open for bidding')

        const existingBid = await m.Bid.findOne({
          where: {
            routeId: routeInst.id,
            userId: userInst.id,
            status: 'bidded'
          },
          ...options
        })

        InvalidArgumentError.assert(!existingBid, 'A bid has already been made for this route')

        const bid = await m.Bid.create({
          routeId: routeInst.id,
          userId: userInst.id,
          price: price,
          status: 'bidded',
        }, {...options})

        return bid
      }
    }
  })
}

export function makeAssociation (modelCache) {
  const Bid = modelCache.require('Bid')
  const Route = modelCache.require('Route')
  const User = modelCache.require('User')

  Bid.belongsTo(Route, {
    foreignKey: "routeId",
  })
  Bid.belongsTo(User, {
    foreignKey: "userId",
  })
}
