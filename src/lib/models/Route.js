/* eslint-disable new-cap */

export default modelCache => {
  let DataTypes = modelCache.db.Sequelize
  return modelCache.db.define(
    "route",
    {
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
      features: DataTypes.TEXT,
    },
    {
      defaultScope: {
        attributes: {
          exclude: ["features"],
        },
      },
    }
  )
}

export const makeAssociation = function(modelCache) {
  let Route = modelCache.require("Route")
  let Trip = modelCache.require("Trip")
  let RouteAnnouncement = modelCache.require("RouteAnnouncement")
  let IndicativeTrip = modelCache.require("IndicativeTrip")
  Route.hasMany(Trip, {
    foreignKey: "routeId",
  })
  Route.hasMany(RouteAnnouncement, {
    foreignKey: "routeId",
  })
  Route.hasOne(IndicativeTrip, {
    foreignKey: "routeId",
  })
  Route.belongsTo(modelCache.models.TransportCompany, {
    foreignKey: "transportCompanyId",
  })
}
