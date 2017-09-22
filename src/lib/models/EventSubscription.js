import _ from "lodash"

export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('eventSubscription', {
    event: DataTypes.STRING,
    transportCompanyId: DataTypes.INTEGER,
    agent: DataTypes.JSONB,
    formatter: DataTypes.STRING,
    handler: DataTypes.STRING,
    params: DataTypes.JSONB,
  })
}

export function makeAssociation (modelCache) {
}
