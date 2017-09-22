export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('driverCompany', {
    driverId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    transportCompanyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // provided by company
    name: DataTypes.TEXT,
    remarks: DataTypes.TEXT,
  }, {
    indexes: [
      {fields: ['driverId', 'transportCompanyId'], unique: true}
    ]
  })
}
