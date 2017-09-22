export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('region', {
    areaName: DataTypes.STRING,
    name: DataTypes.STRING,
    polygon: DataTypes.GEOMETRY("POLYGON")
  })
}

export var postSync = [
  `
    CREATE INDEX region_svy_index ON regions
    USING GIST (polygon);
  `
]

export function makeAssociation (modelCache) {
  var Region = modelCache.require('Region')
  var Route = modelCache.require('Route')
  var RouteRegion = modelCache.require('RouteRegion')
  Region.belongsToMany(Route, {
    through: RouteRegion,
    foreignKey: "regionId"
  })
}
