export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('transaction', {
    committed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    description: DataTypes.TEXT,

    creatorType: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [[
            "system",
            "admin",
            "user",
            "superadmin",
          ]],
          msg: 'Unknown creatorType'
        }
      },
      allowNull: true,
    },
    creatorId: DataTypes.STRING,
    type: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [[
            "ticketPurchase",
            "conversion",
            "refund",
            "referralRewards",
            "routeCreditPurchase",
            "routeCreditExpiry",
            "freeRouteCredit",
            "refundToRouteCredit",
            "routePassPurchase",
            "routePassExpiry",
            "freeRoutePass",
            "refundToRoutePass",
            "refundPayment"
          ]],
          msg: "Unknown type"
        }
      },
      allowNull: true
    }
  },
    {
    // when create a transaction object also include below models
      classMethods: {
        allTransactionTypes () {
          return [{
            model: modelCache.models.TransactionItem,
            include: [
            {model: modelCache.models.RefundPayment, as: "refundPayment"},
            {model: modelCache.models.Payment, as: "payment"},
            {model: modelCache.models.Discount, as: "discount"},
            {model: modelCache.models.Account, as: "account"},
            {model: modelCache.models.Transfer, as: "transfer"},
            {model: modelCache.models.Ticket, as: "ticketSale"},
            {model: modelCache.models.Ticket, as: "ticketExpense"},
            {model: modelCache.models.Ticket, as: "ticketRefund"}
            ]
          }]
        }
      }
    })
}

export function makeAssociation (modelCache) {
  var Transaction = modelCache.require('Transaction')
  var TransactionItem = modelCache.require('TransactionItem')
  /* Define the various transaction types */
  Transaction.hasMany(TransactionItem, {
    foreignKey: "transactionId",
    onDelete: "CASCADE"
  })
}
