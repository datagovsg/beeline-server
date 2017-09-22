import * as auth from '../core/auth'

export default function (modelCache) {
  // FIXME: Node 5.12 why is this not being loaded?
  const ssaclAttributeRoles = require('ssacl-attribute-roles')

  var DataTypes = modelCache.db.Sequelize
  var model = modelCache.db.define('tripDriver', {
    name: {
      type: DataTypes.STRING,
    },
    telephone: {
      type: DataTypes.STRING,
      unique: true,
    },
    tripId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    driverId: {
      type: DataTypes.INTEGER,
    }
  }, {
    instanceMethods:
    {
      makeToken () {
        return auth.signSession({
          role: "driver",
          driverId: this.id,
          lastUpdated: this.updatedAt.getTime()
        })
      },
    },
    timestamps: false,
  })

  ssaclAttributeRoles(model)
  return model
}

export var dontSync = true

export var postSync = [`
  CREATE OR REPLACE VIEW "tripDrivers" AS

  SELECT
    "driverCompanies".name,
    "driverCompanies".remarks,
    "drivers".telephone,
    "trips".id as "tripId",
    "trips"."driverId" as "driverId"
  FROM
    "trips"
    INNER JOIN "routes" ON "trips"."routeId" = "routes"."id"
    LEFT JOIN ("drivers" INNER JOIN "driverCompanies"
      ON "drivers"."id" = "driverCompanies"."driverId")
    ON "drivers".id = "trips"."driverId" AND
      "driverCompanies"."transportCompanyId" = "routes"."transportCompanyId"
  `]

export function makeAssociation (modelCache) {
  var TripDriver = modelCache.models.TripDriver
  var Trip = modelCache.models.Trip

  Trip.hasOne(TripDriver, {
    foreignKey: "tripId"
  })
  TripDriver.belongsTo(Trip, {
    foreignKey: "tripId"
  })
}
