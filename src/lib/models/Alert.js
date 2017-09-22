export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('alert', {
    alertId: {
      type: DataTypes.TEXT,
      primaryKey: true,
    }
  })
}
