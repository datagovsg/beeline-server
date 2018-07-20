import ssaclAttributeRoles from "ssacl-attribute-roles"

/**
 * Returns the model for a TransportCompany
 * @param {object} modelCache
 * @return {Model}
 */
export default function(modelCache) {
  let DataTypes = modelCache.db.Sequelize
  let Company = modelCache.db.define(
    "transportCompany",
    {
      type: DataTypes.INTEGER,
      logo: DataTypes.BLOB,
      name: DataTypes.STRING(50), // eslint-disable-line
      email: DataTypes.STRING(50), // eslint-disable-line
      contactNo: DataTypes.STRING(50), // eslint-disable-line
      smsOpCode: {
        type: DataTypes.STRING(11), // eslint-disable-line
        allowNull: true,
      },
      features: DataTypes.TEXT,
      terms: DataTypes.TEXT,
      clientId: {
        type: DataTypes.STRING,
        roles: false,
      },
      clientSecret: {
        type: DataTypes.STRING,
        roles: false,
      },
      sandboxId: {
        type: DataTypes.STRING,
        roles: false,
      },
      sandboxSecret: {
        type: DataTypes.STRING,
        roles: false,
      },
      /* We don't leak the client id to users of the API, so we
       leak the presence of it instead */
      hasClientId: {
        type: DataTypes.VIRTUAL,
        get() {
          return !!this.getDataValue("clientId")
        },
      },
      referrer: DataTypes.STRING,
      status: DataTypes.STRING,
    },
    {
      defaultScope: {
        attributes: { exclude: ["logo", "features", "terms"] }, // exclude by default the heavy attributes
      },
    }
  )

  ssaclAttributeRoles(Company)
  return Company
}

/**
 *
 * @param {object} modelCache
 */
export function makeAssociation(modelCache) {
  let Driver = modelCache.require("Driver")
  let TransportCompany = modelCache.require("TransportCompany")
  let DriverCompany = modelCache.require("DriverCompany")
  let ContactList = modelCache.require("ContactList")

  TransportCompany.belongsToMany(Driver, {
    through: DriverCompany,
    foreignKey: "transportCompanyId",
  })

  TransportCompany.hasMany(ContactList, {
    foreignKey: "transportCompanyId",
  })
}
