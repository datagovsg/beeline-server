export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('userSuggestedRouteStop', {
    userSuggestedRouteId: DataTypes.INTEGER,
    arriveAt: DataTypes.INTEGER,
    stopId: DataTypes.INTEGER,
  })
}

export function makeAssociation (modelCache) {
  modelCache.models.UserSuggestedRouteStop.belongsTo(modelCache.models.Stop, {
    foreignKey: "stopId",
  })
}
