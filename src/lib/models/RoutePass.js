import assert from 'assert'

export default function (modelCache) {
  const STATUSES = ["failed", "valid", "void", "refunded", "pending", "expired"]

  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('routePass', {
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
    status: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [STATUSES],
          msg: 'Must be one of ' + STATUSES.join(',')
        }
      },
      allowNull: false,
    },
    notes: DataTypes.JSONB
  }, {
    indexes: [
      {fields: ["userId", "status"]},
      {fields: ["companyId", "tag"]},
    ],
    classMethods: {
      async refundFromTicket (tb, previousTransactionItem, companyId, userId, tag) {
        const {models, transaction} = tb

        assert(previousTransactionItem.itemType === 'ticketSale',
          `Trying to refund route credits from an item of type ${previousTransactionItem.itemType}`)

        const amountToRefund = Math.abs(previousTransactionItem.debit)
        assert(typeof (amountToRefund) === 'number' && isFinite(amountToRefund),
          `The previous transaction specified an incorrect amount to refund`)

        const notes = { price: amountToRefund, refundedTicketId: previousTransactionItem.itemId }
        const routePass = await models.RoutePass.create(
          {userId, companyId, tag, status: 'valid', notes},
          {transaction}
        )

        tb.undoFunctions.push(
          (t) => routePass.update({status: 'failed'}, {transaction: t})
        )

        tb.transactionItemsByType.routePass = tb.transactionItemsByType.routePass || []
        tb.transactionItemsByType.routePass.push({
          itemType: 'routePass',
          itemId: routePass.id,
          credit: amountToRefund
        })

        let cogsAcc = await models.Account.getByName(
          'Cost of Goods Sold', {transaction}
        )

        let upstreamCreditsAcc = await models.Account.getByName(
          'Upstream Refunds', {transaction}
        )

        tb.transactionItemsByType.account = tb.transactionItemsByType.account || []
        tb.transactionItemsByType.account.push({
          itemType: 'account',
          itemId: upstreamCreditsAcc.id,
          credit: amountToRefund,
          notes: { transportCompanyId: companyId }
        })
        tb.transactionItemsByType.account.push({
          itemType: 'account',
          itemId: cogsAcc.id,
          debit: amountToRefund,
          notes: null
        })

        return tb
      }
    }
  })
}

export function makeAssociation (modelCache) {
  var User = modelCache.require('User')
  var RoutePass = modelCache.require('RoutePass')
  var TransportCompany = modelCache.require('TransportCompany')
  var TransactionItem = modelCache.require('TransactionItem')
  RoutePass.belongsTo(User, {
    foreignKey: "userId"
  })
  RoutePass.belongsTo(TransportCompany, {
    foreignKey: "companyId"
  })
  RoutePass.hasMany(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: {
        $in: ["routePass"]
      }
    }
  })
}
