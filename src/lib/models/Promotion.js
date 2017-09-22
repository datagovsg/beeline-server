export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('promotion', {
    code: DataTypes.TEXT,
    type: DataTypes.TEXT,
    params: DataTypes.JSONB,
    description: DataTypes.TEXT
  }, {
    indexes: [
      {fields: ['code']}
    ]
  })
}

export function makeAssociation (modelCache) {
  var Promotion = modelCache.require('Promotion')
  var PromoUsage = modelCache.require('PromoUsage')

  Promotion.hasMany(PromoUsage, {
    foreignKey: "promoId"
  })
}
