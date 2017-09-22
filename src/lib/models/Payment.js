export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('payment', {
    paymentResource: DataTypes.STRING,
    incoming: DataTypes.DECIMAL(10, 2),
    /* Store credit/debit in the same column, but in opposite sign */
    outgoing: {
      type: DataTypes.VIRTUAL,
      set: function (val) {
        this.setDataValue("incoming", modelCache.neg(val))
      },
      get: function () {
        return modelCache.neg(this.getDataValue("incoming"))
      }
    },
    data: DataTypes.JSON,
    options: DataTypes.JSONB,
  })
}

export function makeAssociation (modelCache) {
  var Payment = modelCache.require('Payment')
  var TransactionItem = modelCache.require('TransactionItem')
  // user pay to Beeline
  Payment.hasOne(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "payment"
    }
  })
}
