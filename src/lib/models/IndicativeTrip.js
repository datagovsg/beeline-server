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
    "routeNextTrip" AS (
      SELECT DISTINCT ON (trips."routeId")
        trips.*
      FROM trips INNER JOIN "tripStops" ON "tripStops"."tripId" = trips.id
      WHERE
        "tripStops".time > CURRENT_TIMESTAMP
      ORDER BY
        trips."routeId", "tripStops".time ASC
    ),

    "routeLastTrip" AS (
      SELECT DISTINCT ON (trips."routeId")
        trips.*
      FROM trips INNER JOIN "tripStops" ON "tripStops"."tripId" = trips.id
      ORDER BY
        trips."routeId", "trips".date DESC
    ),

    "tripStart" AS (
      SELECT DISTINCT ON ("tripId")
        "tripId",
        "tripStops"."time",
        "stops"."description"
      FROM "tripStops" INNER JOIN "stops" ON "tripStops"."stopId" = "stops".id
      WHERE "tripId" IN (SELECT "id" FROM "routeNextTrip")
        OR "tripId" IN (SELECT "id" FROM "routeLastTrip")
      ORDER BY "tripId", "tripStops"."time" ASC
    ),

    "tripEnd" AS (
      SELECT DISTINCT ON ("tripId")
        "tripId",
        "tripStops"."time",
        "stops"."description"
      FROM "tripStops" INNER JOIN "stops" ON "tripStops"."stopId" = "stops".id
      WHERE "tripId" IN (SELECT "id" FROM "routeNextTrip")
        OR "tripId" IN (SELECT "id" FROM "routeLastTrip")
      ORDER BY "tripId", "tripStops"."time" DESC
    )

  SELECT

    -- For backward compatibility until we upgrade all the admin views
    "routeNextTrip"."id" as "tripId",

    "routes"."id" as "routeId",
    "routeNextTrip"."id" as "nextTripId",
    "routeNextTrip"."price" as "nextPrice",
    "routeNextTrip"."capacity" as "nextCapacity",
    ("nextTripStart"."time" - "routeNextTrip"."date") as "nextStartTime",
    ("nextTripEnd"."time" - "routeNextTrip"."date") as "nextEndTime",
    "nextTripStart"."description" as "nextStartDescription",
    "nextTripEnd"."description" as "nextEndDescription",
    "nextTripDriver"."id" AS "nextDriverId",
    "nextTripDriver"."name" AS "nextDriverName",

    "routeLastTrip"."id" as "lastTripId",
    "routeLastTrip"."price" as "lastPrice",
    "routeLastTrip"."capacity" as "lastCapacity",
    ("lastTripStart"."time" - "routeLastTrip"."date") as "lastStartTime",
    ("lastTripEnd"."time" - "routeLastTrip"."date") as "lastEndTime",
    "lastTripStart"."description" as "lastStartDescription",
    "lastTripEnd"."description" as "lastEndDescription",
    "lastTripDriver"."id" AS "lastDriverId",
    "lastTripDriver"."name" AS "lastDriverName"
  FROM
    "routes"

    LEFT OUTER JOIN ("routeNextTrip"
    INNER JOIN "tripStart" AS "nextTripStart" ON "routeNextTrip"."id" = "nextTripStart"."tripId"
    INNER JOIN "tripEnd" AS "nextTripEnd" ON "routeNextTrip"."id" = "nextTripEnd"."tripId"
    LEFT OUTER JOIN "drivers" AS "nextTripDriver" ON "routeNextTrip"."driverId" = "nextTripDriver".id)

      ON "routeNextTrip"."routeId" = "routes".id

    FULL OUTER JOIN ("routeLastTrip"
    INNER JOIN "tripStart" AS "lastTripStart" ON "routeLastTrip"."id" = "lastTripStart"."tripId"
    INNER JOIN "tripEnd" AS "lastTripEnd" ON "routeLastTrip"."id" = "lastTripEnd"."tripId"
    LEFT OUTER JOIN "drivers" AS "lastTripDriver" ON "routeLastTrip"."driverId" = "lastTripDriver".id)
     ON "routeLastTrip"."routeId" = "routes"."id"
`,
]
