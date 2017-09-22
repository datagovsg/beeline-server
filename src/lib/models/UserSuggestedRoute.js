export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('userSuggestedRoute', {
    email: DataTypes.STRING,
    name: DataTypes.STRING,
    path: DataTypes.GEOMETRY("LINESTRING"),
  })
}

export function makeAssociation (modelCache) {
  modelCache.models.UserSuggestedRouteStop.belongsTo(modelCache.models.UserSuggestedRoute, {
    foreignKey: "userSuggestedRouteId",
  })
  modelCache.models.UserSuggestedRoute.hasMany(modelCache.models.UserSuggestedRouteStop, {
    foreignKey: "userSuggestedRouteId",
  })
}
