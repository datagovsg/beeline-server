// log purpose
export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('transfer', {
    /* Either company id OR thirdParty must be
        used */
    transportCompanyId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    thirdParty: DataTypes.STRING,
    token: DataTypes.STRING,

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
    }
  },
    {
      indexes: [
      {fields: ["transportCompanyId"]} /* Necessary for reverse lookup */
      ]
    })
}

export function makeAssociation (modelCache) {
  var Transfer = modelCache.require('Transfer')
  var TransactionItem = modelCache.require('TransactionItem')
  Transfer.hasOne(TransactionItem, {
    // transfer id as itemId
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "transfer"
    }
  })
}
