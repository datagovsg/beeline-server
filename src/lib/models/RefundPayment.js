export default modelCache => {
  const DataTypes = modelCache.db.Sequelize
  return modelCache.db.define("refundPayment", {
    paymentResource: DataTypes.STRING,
    incoming: DataTypes.DECIMAL(10, 2), // eslint-disable-line new-cap
    /* Store credit/debit in the same column, but in opposite sign */
    outgoing: {
      type: DataTypes.VIRTUAL,
      set: function(val) {
        this.setDataValue("incoming", modelCache.neg(val))
      },
      get: function() {
        return modelCache.neg(this.getDataValue("incoming"))
      },
    },
    data: DataTypes.JSON,
  })
}

export const makeAssociation = function makeAssociation(modelCache) {
  const RefundPayment = modelCache.require("RefundPayment")
  const TransactionItem = modelCache.require("TransactionItem")
  RefundPayment.hasOne(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "refundPayment",
    },
  })
}
