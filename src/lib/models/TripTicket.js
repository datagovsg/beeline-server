export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('tripTicket', {
    email: DataTypes.STRING,
    name: DataTypes.STRING,
    telephone: {
      type: DataTypes.STRING,
      allowNull: true
    },
    userId: DataTypes.INTEGER,
    ticketId: DataTypes.INTEGER,
    tripId: DataTypes.INTEGER,
    boardStopId: DataTypes.INTEGER,
    alightStopId: DataTypes.INTEGER,
    committed: DataTypes.BOOLEAN,
    status: DataTypes.STRING
  },
  {timestamps: false})
}

export var dontSync = true

export var postSync = [
  `
  CREATE OR REPLACE VIEW "tripTickets" AS
  SELECT users.id AS "userId",
  users.id,
  users.email,
  users.name,
  users.telephone,
  users."passwordHash",
  users.type,
  users."createdAt",
  users."updatedAt",
  tickets."boardStopId",
  tickets."alightStopId",
  tickets.id AS "ticketId",
  tickets.status as "status",
  trips.id AS "tripId",
  transactions.committed
   FROM tickets
   JOIN users ON tickets."userId" = users.id
   JOIN "tripStops" ON tickets."boardStopId" = "tripStops".id
   JOIN trips ON "tripStops"."tripId" = trips.id
   LEFT JOIN "transactionItems" ON "transactionItems"."itemId" = tickets.id AND "transactionItems"."itemType"::text ~~ 'ticket%'::text
   LEFT JOIN transactions ON "transactionItems"."transactionId" = transactions.id;
  `
]


export function makeAssociation (modelCache) {
  var Trip = modelCache.require('Trip')
  var TripTicket = modelCache.require('TripTicket')
  TripTicket.belongsTo(Trip, {
    foreignKey: "tripId"
  })
}
