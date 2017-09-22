export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('ping', {
    coordinates: {
      type: DataTypes.GEOMETRY("POINT"),
      allowNull: true
    },
    time: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false
    },
    tripId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    // depends on how to link ping to driver or vehicle
    driverId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    vehicleId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: true
    }
  },
    {
      indexes: [
      {fields: ["tripId", "time"]},
      {fields: ["driverId", "time"]},
      {fields: ["vehicleId", "time"]},
      ]
    })
}

export function makeAssociation (modelCache) {
  var Trip = modelCache.require('Trip')
  var Ping = modelCache.require('Ping')
  Ping.belongsTo(Trip, {
    foreignKey: "tripId"
  })
}
