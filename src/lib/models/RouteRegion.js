export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('routeRegion', {
    regionId: {
      type: DataTypes.INTEGER,
      references: {
        model: modelCache.require('Region')
      }
    },
    routeId: {
      type: DataTypes.INTEGER,
      references: {
        model: modelCache.require('Route')
      }
    }
  }, {timestamps: false})
}

export var dontSync = true

export var postSync = [
  `
  CREATE OR REPLACE VIEW "routeRegions" AS
WITH "firstTrips" AS (
				 SELECT distinct on (trips_2."routeId")
                    trips_2."routeId",
     				trips_2.id
                   FROM trips trips_2
                  WHERE trips_2.date > now()
               ORDER BY trips_2."routeId", trips_2."date" ASC
        )
 SELECT DISTINCT trips."routeId",
    regions.id AS "regionId"
   FROM
     "firstTrips" AS trips
     JOIN routes ON trips."routeId" = routes.id
     JOIN "tripStops" ON trips.id = "tripStops"."tripId"
     JOIN stops ON stops.id = "tripStops"."stopId"
     JOIN regions ON st_contains(regions.polygon, stops.coordinates)
     ORDER BY "routeId", "regionId"
  -- delete from regions where polygon is not null
  `
]
