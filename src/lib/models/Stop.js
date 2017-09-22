export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('stop', {
    description: DataTypes.STRING,
    road: DataTypes.STRING,
    label: DataTypes.STRING,
    postcode: DataTypes.STRING,
    type: DataTypes.STRING,
    coordinates: DataTypes.GEOMETRY("POINT"),
    viewUrl: DataTypes.STRING,
  })
}

export var postSync = [
  `
  CREATE INDEX stop_svy_index ON stops
  USING GIST (
  ST_Transform(ST_SetSRID(coordinates, 4326), 3414));
  `
]
