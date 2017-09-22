import _ from "lodash"
export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('account', {
    name: DataTypes.STRING
  },
    {
      classMethods: {
        getByName (name, options) {
          return this.findOrCreate(_.assign({
            where: { name },
            defaults: { name },
          }, options))
        .then((inst_isCreated) => {
          return inst_isCreated[0]
        })
        }
      }
    })
}

export function makeAssociation (modelCache) {
  var Account = modelCache.require('Account')
  var TransactionItem = modelCache.require('TransactionItem')
  // not has One, e.g. cost of goods sold
  Account.hasMany(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: "account"
    }
  })
}
