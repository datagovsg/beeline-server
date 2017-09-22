export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('routeAnnouncement', {
    validFrom: DataTypes.DATE,
    validTo: DataTypes.DATE,
    routeId: {
      type: DataTypes.INTEGER,
    },
    title: DataTypes.STRING,
    message: DataTypes.STRING
  }, {
    indexes: [
       {fields: ["routeId"]}
    ]
  })
}

export function makeAssociation (modelCache) {
  var RouteAnnouncement = modelCache.require('RouteAnnouncement')
  var Route = modelCache.require('Route')
  RouteAnnouncement.belongsTo(Route, {
    foreignKey: "routeId"
  })
}
