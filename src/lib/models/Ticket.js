import _ from "lodash"
import Sequelize from "sequelize"
import {TransactionError} from '../transactions'

export const STATUSES = ['failed', 'valid', 'void', 'refunded', 'pending']

export default function (modelCache) {
  const VOID_STATUSES = ['void', 'refunded', 'failed']
  const VALID_STATUSES = _.difference(STATUSES, VOID_STATUSES)

  const updateAvailability = op => async (tickets, options) => {
    const TripStop = modelCache.require('TripStop')
    const Trip = modelCache.require('Trip')
    if (tickets.length === 0) {
      return
    }
    const boardStops = await TripStop.findAll({
      where: { id: { $in: _.uniq(tickets.map(t => t.boardStopId)) } },
      attributes: ['id', 'tripId'],
      transaction: options.transaction,
    })
    const boardStopById = _.keyBy(boardStops, 'id')
    const tripIds = tickets.map(t => boardStopById[t.boardStopId].tripId)

    return _.forEach(_.countBy(tripIds), async (seatsBooked, tripId) => {
      await Trip.update(
        {seatsAvailable: Sequelize.literal('"seatsAvailable" ' + op + ' ' + seatsBooked)},
        {
          where: { id: tripId },
          transaction: options.transaction,
        }
      )
    })
  }

  const beforeBulkCreate = updateAvailability('-')

  const statusChanged = (from, to, ticket) =>
    _.includes(from, ticket._previousDataValues.status) &&
    _.includes(to, ticket.get('status'))
  const becameVoid = ticket => statusChanged(VALID_STATUSES, VOID_STATUSES, ticket)
  const becameValid = ticket => statusChanged(VOID_STATUSES, VALID_STATUSES, ticket)

  const afterUpdate = (ticket, options) => {
    if (becameVoid(ticket)) {
      return updateAvailability('+')([ticket], options)
    } else if (becameValid(ticket)) {
      return updateAvailability('-')([ticket], options)
    }
  }

  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('ticket', {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    alightStopId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    boardStopId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [STATUSES],
          msg: 'Must be a F/V/V/R/P'
        }
      },
      allowNull: false,
    },
    notes: DataTypes.JSONB
  }, {
    hooks: {
      beforeCreate: (ticket, options) => beforeBulkCreate([ticket], options),
      beforeBulkCreate,
      afterUpdate,
      afterBulkUpdate: (t, o) => {
        throw new TransactionError(
          'Bulk updates not supported, individual updates necessary to maintain seat availability'
        )
      },
    },
    indexes: [
      {fields: ["boardStopId", "status"]},
      {fields: ["alightStopId"]}
    ]
  })
}

export function makeAssociation (modelCache) {
  var Ticket = modelCache.require('Ticket')
  var TripStop = modelCache.require('TripStop')
  var TransactionItem = modelCache.require('TransactionItem')
  var User = modelCache.require('User')

  Ticket.belongsTo(TripStop, {
    foreignKey: "boardStopId",
    as: "boardStop",
    onDelete: 'NO ACTION',
  })

  Ticket.belongsTo(TripStop, {
    foreignKey: "alightStopId",
    as: "alightStop",
  })
  Ticket.hasMany(TransactionItem, {
    foreignKey: "itemId",
    constraints: false,
    scope: {
      itemType: {
        $in: ["ticketRefund", "ticketExpense", "ticketSale"]
      }
    }
  })
  Ticket.belongsTo(User, {
    foreignKey: "userId"
  })
}
