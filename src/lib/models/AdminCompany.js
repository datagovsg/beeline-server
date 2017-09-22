export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('adminCompany', {
    adminId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    transportCompanyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    name: DataTypes.TEXT,
    permissions: DataTypes.ARRAY(DataTypes.STRING),
  }, {
    indexes: [
      {fields: ['adminId', 'transportCompanyId'], unique: true}
    ]
  })
}

export function makeAssociation (modelCache) {
  modelCache.models.Admin.belongsToMany(modelCache.models.TransportCompany, {
    through: modelCache.models.AdminCompany
  })
  modelCache.models.TransportCompany.belongsToMany(modelCache.models.Admin, {
    through: modelCache.models.AdminCompany
  })
}
