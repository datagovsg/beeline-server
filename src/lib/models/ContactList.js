export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('contactList', {
    transportCompanyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    description: DataTypes.STRING,
    telephones: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
    },
    emails: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
    },
  },
    {
      indexes: [
      { fields: ["transportCompanyId"] }
      ]
    })
}

export function makeAssociation (modelCache) {
  var TransportCompany = modelCache.require('TransportCompany')
  var ContactList = modelCache.require('ContactList')

  ContactList.belongsTo(TransportCompany, {
    foreignKey: "transportCompanyId"
  })
}
