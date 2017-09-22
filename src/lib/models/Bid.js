export default function (modelCache) {
  const VOID_STATUSES = ['void', 'withdrawn', 'failed']
  const VALID_STATUSES = ['pending', 'bidded']
  const STATUSES = VOID_STATUSES.concat(VALID_STATUSES)

  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('bid', {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [STATUSES],
          msg: 'Must be one of ' + STATUSES,
        }
      },
      allowNull: false,
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    priceF: {
      type: DataTypes.VIRTUAL,
      set: function (val) {
        this.setDataValue('price', val)
      },
      get: function () {
        const v = this.getDataValue('price')
        return (v == null) ? null : parseFloat(v)
      },
    },
    notes: DataTypes.JSONB
  }, {
    indexes: [
      {fields: ["userId"]},
      {fields: ["routeId"]}
    ]
  })
}

export function makeAssociation (modelCache) {
  const Bid = modelCache.require('Bid')
  const Route = modelCache.require('Route')
  const User = modelCache.require('User')

  Bid.belongsTo(Route, {
    foreignKey: "routeId",
  })
  Bid.belongsTo(User, {
    foreignKey: "userId",
  })
}
