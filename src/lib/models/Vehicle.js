export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('vehicle', {
    vehicleNumber: DataTypes.STRING(10),
    driverId: DataTypes.INTEGER,
    photo: DataTypes.BLOB
  },
    {
      indexes: [
       {fields: ["driverId"]}
      ]
    })
}

export function makeAssociation (modelCache) {
  var Driver = modelCache.require('Driver')
  var Vehicle = modelCache.require('Vehicle')
  Vehicle.belongsTo(Driver, {
    foreignKey: "driverId"
  })
}
