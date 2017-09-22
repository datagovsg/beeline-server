export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('discount', {
    description: DataTypes.STRING,
    code: DataTypes.STRING,
    userOptions: DataTypes.JSONB,
    discountAmounts: DataTypes.JSONB,
    refundAmounts: DataTypes.JSONB,
    promotionId: DataTypes.INTEGER,
    params: DataTypes.JSONB,
  }, {
    indexes: [
      {fields: ['code']}
    ]
  })
}

export function makeAssociation (modelCache) {
  var Discount = modelCache.require('Discount')
  var TransactionItem = modelCache.require('TransactionItem')

  Discount.hasOne(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "discount"
    }
  })
}
