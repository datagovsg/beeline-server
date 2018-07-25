/**
 *
 * @param {*} modelCache
 * @return {Model} the model for IndicativeTrip
 */
export default function(modelCache) {
  let DataTypes = modelCache.db.Sequelize
  return modelCache.db.define(
    "indicativeTrip",
    {
      routeId: {
        type: DataTypes.INTEGER,
        references: {
          model: modelCache.require("Route"),
        },
        primaryKey: true,
      },
      nextTripId: DataTypes.INTEGER,
      nextPrice: DataTypes.DECIMAL(10, 2), //eslint-disable-line
      nextCapacity: DataTypes.INTEGER,
      nextStartTime: DataTypes.DATE,
      nextEndTime: DataTypes.DATE,
      nextStartDescription: DataTypes.TEXT,
      nextEndDescription: DataTypes.TEXT,
      nextDriverId: DataTypes.INTEGER,
      nextDriverName: DataTypes.STRING,

      lastTripId: DataTypes.INTEGER,
      lastPrice: DataTypes.DECIMAL(10, 2), //eslint-disable-line
      lastCapacity: DataTypes.INTEGER,
      lastStartTime: DataTypes.DATE,
      lastEndTime: DataTypes.DATE,
      lastStartDescription: DataTypes.TEXT,
      lastEndDescription: DataTypes.TEXT,
      lastDriverId: DataTypes.INTEGER,
      lastDriverName: DataTypes.STRING,
    },
    { timestamps: false }
  )
}

export const dontSync = true

export const postSync = [
  `
  CREATE OR REPLACE VIEW "indicativeTrips" AS

  WITH
    "routeNextTripIds" AS (
      SELECT
        trips."routeId",
        MAX(trips."id") AS "tripId"
      FROM
        trips INNER JOIN
          (SELECT -- fetch the minimum date after today for each routeID
            "routeId",
            MIN("date") as "minDate"
          FROM trips
          WHERE date >= (CURRENT_TIMESTAMP at time zone (INTERVAL '+08:00'))::date
          GROUP BY "routeId") AS "tripsWithMinDate"
        ON trips."routeId" = "tripsWithMinDate"."routeId" AND trips."date" = "tripsWithMinDate"."minDate"
      GROUP BY trips."routeId", "trips".date
    ),

    "routeLastTripIds" AS (
      SELECT
        trips."routeId",
        MAX(trips."id") AS "tripId"
      FROM
        trips INNER JOIN
          (SELECT -- fetch the minimum date after today for each routeID
            "routeId",
            MAX("date") as "maxDate"
          FROM trips
          GROUP BY "routeId") AS "tripsWithMaxDate"
        ON trips."routeId" = "tripsWithMaxDate"."routeId" AND trips."date" = "tripsWithMaxDate"."maxDate"
      GROUP BY trips."routeId", "trips".date
    ),

    "tripLastTripStopId" AS (
      SELECT
        "tripStops"."tripId",
        MAX("tripStops"."id") as "tripStopId"
      FROM
        "tripStops" INNER JOIN
          (SELECT
            "tripId", MAX(time) AS "maxTime"
          FROM "tripStops"
          WHERE "tripStops"."tripId" IN (SELECT "tripId" FROM "routeLastTripIds" UNION SELECT "tripId" FROM "routeNextTripIds")
          GROUP BY "tripId") AS "maxTimes"
          ON "tripStops"."tripId" = "maxTimes"."tripId" AND "maxTimes"."maxTime" = "tripStops".time
      GROUP BY
        "tripStops"."tripId", "tripStops".time
    ),

    "tripFirstTripStopId" AS (
      SELECT
        "tripStops"."tripId",
        MAX("tripStops"."id") as "tripStopId"
      FROM
        "tripStops" INNER JOIN
          (SELECT "tripId", MIN(time) AS "minTime"
          FROM "tripStops"
          WHERE "tripStops"."tripId" IN (SELECT "tripId" FROM "routeLastTripIds" UNION SELECT "tripId" FROM "routeNextTripIds")
          GROUP BY "tripId") AS "minTimes"
          ON "tripStops"."tripId" = "minTimes"."tripId" AND "minTimes"."minTime" = "tripStops".time
      WHERE "tripStops"."tripId" IN (SELECT "tripId" FROM "routeLastTripIds" UNION SELECT "tripId" FROM "routeNextTripIds")
      GROUP BY
        "tripStops"."tripId", "tripStops".time
    )

  SELECT
    "routes"."id" as "routeId",
    "routeNextTrip"."id" as "nextTripId",
    "routeNextTrip"."price" as "nextPrice",
    "routeNextTrip"."capacity" as "nextCapacity",
    ("nextTripFirstTripStop"."time" - "routeNextTrip"."date") as "nextStartTime",
    ("nextTripLastTripStop"."time" - "routeNextTrip"."date") as "nextEndTime",
    "nextTripFirstStop"."description" as "nextStartDescription",
    "nextTripLastStop"."description" as "nextEndDescription",
    "nextTripDriver"."id" AS "nextDriverId",
    "nextTripDriver"."name" AS "nextDriverName",

    "routeLastTrip"."id" as "lastTripId",
    "routeLastTrip"."price" as "lastPrice",
    "routeLastTrip"."capacity" as "lastCapacity",
    ("lastTripFirstTripStop"."time" - "routeLastTrip"."date") as "lastStartTime",
    ("lastTripLastTripStop"."time" - "routeLastTrip"."date") as "lastEndTime",
    "lastTripFirstStop"."description" as "lastStartDescription",
    "lastTripLastStop"."description" as "lastEndDescription",
    "lastTripDriver"."id" AS "lastDriverId",
    "lastTripDriver"."name" AS "lastDriverName"
  FROM
    "routes"

    LEFT OUTER JOIN "routeNextTripIds" ON routes.id = "routeNextTripIds"."routeId"
    LEFT OUTER JOIN "routeLastTripIds" ON routes.id = "routeLastTripIds"."routeId"

    LEFT JOIN "trips" AS "routeNextTrip" ON "routeNextTrip".id = "routeNextTripIds"."tripId"
    LEFT JOIN "trips" AS "routeLastTrip" ON "routeLastTrip".id = "routeLastTripIds"."tripId"

    LEFT JOIN "tripFirstTripStopId" AS "nextTripFirstTripStopId" ON "routeNextTrip".id = "nextTripFirstTripStopId"."tripId"
    LEFT JOIN "tripLastTripStopId" AS "nextTripLastTripStopId" ON "routeNextTrip".id = "nextTripLastTripStopId"."tripId"
    LEFT JOIN "tripFirstTripStopId" AS "lastTripFirstTripStopId" ON "routeLastTrip".id = "lastTripFirstTripStopId"."tripId"
    LEFT JOIN "tripLastTripStopId" AS "lastTripLastTripStopId" ON "routeLastTrip".id = "lastTripLastTripStopId"."tripId"

    LEFT JOIN "tripStops" AS "nextTripFirstTripStop" ON "nextTripFirstTripStopId"."tripStopId" = "nextTripFirstTripStop".id
    LEFT JOIN "tripStops" AS "nextTripLastTripStop" ON "nextTripLastTripStopId"."tripStopId" = "nextTripLastTripStop".id
    LEFT JOIN "tripStops" AS "lastTripFirstTripStop" ON "lastTripFirstTripStopId"."tripStopId" = "lastTripFirstTripStop".id
    LEFT JOIN "tripStops" AS "lastTripLastTripStop" ON "lastTripLastTripStopId"."tripStopId" = "lastTripLastTripStop".id

    LEFT JOIN "stops" AS "nextTripFirstStop" ON "nextTripFirstTripStop"."stopId" = "nextTripFirstStop".id
    LEFT JOIN "stops" AS "nextTripLastStop" ON "nextTripLastTripStop"."stopId" = "nextTripLastStop".id
    LEFT JOIN "stops" AS "lastTripFirstStop" ON "lastTripFirstTripStop"."stopId" = "lastTripFirstStop".id
    LEFT JOIN "stops" AS "lastTripLastStop" ON "lastTripLastTripStop"."stopId" = "lastTripLastStop".id

    LEFT JOIN "drivers" AS "nextTripDriver" ON "nextTripDriver".id = "routeNextTrip"."driverId"
    LEFT JOIN "drivers" AS "lastTripDriver" ON "lastTripDriver".id = "routeLastTrip"."driverId";
`,
]
