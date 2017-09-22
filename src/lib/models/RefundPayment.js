export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('refundPayment', {
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
    data: DataTypes.JSON
  })
}

export function makeAssociation (modelCache) {
  var RefundPayment = modelCache.require('RefundPayment')
  var TransactionItem = modelCache.require('TransactionItem')
  RefundPayment.hasOne(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "refundPayment"
    }
  })
}
