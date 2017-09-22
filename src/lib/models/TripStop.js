export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('tripStop', {
    tripId: {
      type: DataTypes.INTEGER,
    },
    stopId: {
      type: DataTypes.INTEGER,
    },
    canBoard: DataTypes.BOOLEAN,
    canAlight: DataTypes.BOOLEAN,
    time: DataTypes.DATE
  },
    {
      indexes: [
      {fields: ["tripId"]},
      {fields: ["stopId"]},
      {fields: ["time", "tripId"]}
      ]
    })
}

export function makeAssociation (modelCache) {
  var Trip = modelCache.require('Trip')
  var Stop = modelCache.require('Stop')
  var TripStop = modelCache.require('TripStop')
  var Ticket = modelCache.require('Ticket')
  TripStop.belongsTo(Stop, {
    foreignKey: "stopId"
  })
  TripStop.belongsTo(Trip, {
    foreignKey: "tripId"
  })
  TripStop.hasMany(Ticket, {
    foreignKey: "boardStopId",
    onDelete: 'NO ACTION',
  })
}
