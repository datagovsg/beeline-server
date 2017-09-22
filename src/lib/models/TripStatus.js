export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('tripStatus', {
    time: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false
    },
    creator: DataTypes.STRING,
    message: {
      type: DataTypes.TEXT
    },
    tripId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false
    }
  },
    {
      indexes: [
      {fields: ["tripId"]}
      ]
    })
}

export function makeAssociation (modelCache) {
  var Trip = modelCache.require('Trip')
  var TripStatus = modelCache.require('TripStatus')
  TripStatus.belongsTo(Trip, {
    foreignKey: "tripId"
  })
}
