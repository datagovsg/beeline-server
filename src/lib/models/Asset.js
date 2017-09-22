export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize

  return modelCache.db.define('asset', {
    id: {
      type: DataTypes.STRING(50),
      primaryKey: true,
    },
    data: DataTypes.TEXT,
  })
}
