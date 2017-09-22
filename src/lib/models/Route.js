export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('route', {
    name: DataTypes.STRING,
    from: DataTypes.STRING,
    to: DataTypes.STRING,
    path: DataTypes.JSON,
    transportCompanyId: DataTypes.INTEGER,
    label: DataTypes.STRING,
    schedule: DataTypes.STRING,
    tags: DataTypes.ARRAY(DataTypes.STRING),
    companyTags: DataTypes.ARRAY(DataTypes.STRING),
    notes: DataTypes.JSONB,
    features: DataTypes.TEXT
  }, {
    defaultScope: {
      attributes: {
        exclude: ["features"]
      }
    }
  })
}

export function makeAssociation (modelCache) {
  var Region = modelCache.require('Region')
  var Route = modelCache.require('Route')
  var Trip = modelCache.require('Trip')
  var RouteRegion = modelCache.require('RouteRegion')
  var RouteAnnouncement = modelCache.require('RouteAnnouncement')
  var IndicativeTrip = modelCache.require('IndicativeTrip')
  Route.belongsToMany(Region, {
    through: RouteRegion,
    foreignKey: "routeId"
  })
  Route.hasMany(Trip, {
    foreignKey: "routeId"
  })
  Route.hasMany(RouteAnnouncement, {
    foreignKey: "routeId"
  })
  Route.hasOne(IndicativeTrip, {
    foreignKey: "routeId"
  })
  Route.belongsTo(modelCache.models.TransportCompany, {
    foreignKey: "transportCompanyId"
  })
}
