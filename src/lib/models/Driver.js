const ssaclAttributeRoles = require('ssacl-attribute-roles')
import * as auth from '../core/auth'

export default function (modelCache) {
  // FIXME: Node 5.12 why is this not being loaded?
  const ssaclAttributeRoles = require('ssacl-attribute-roles')

  var DataTypes = modelCache.db.Sequelize
  var model = modelCache.db.define('driver', {
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    telephone: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    pairingCode: {
      type: DataTypes.STRING,
      roles: false,
    },
    passwordHash: {
      type: DataTypes.STRING,
      roles: false,
    },
    authKey: {
      type: DataTypes.STRING,
      roles: false,
    },
    lastComms: DataTypes.DATE,
  },
    {
      instanceMethods:
      {
        makeToken () {
          return auth.signSession({
            role: "driver",
            driverId: this.id,
            lastUpdated: this.updatedAt.getTime()
          })
        },
      }
    })

  ssaclAttributeRoles(model)
  return model
}

export function makeAssociation (modelCache) {
  var Driver = modelCache.require('Driver')
  var Vehicle = modelCache.require('Vehicle')
  var TransportCompany = modelCache.require('TransportCompany')
  var DriverCompany = modelCache.require('DriverCompany')
  Driver.hasMany(Vehicle, {
    foreignKey: "driverId"
  })
  Driver.belongsToMany(TransportCompany, {
    through: DriverCompany,
    foreignKey: "driverId"
  })
}
