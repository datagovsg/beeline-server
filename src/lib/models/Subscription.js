export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('subscription', {
    // userId and routeId combined has to be unique
    userId: {type: DataTypes.INTEGER},
    routeLabel: {type: DataTypes.STRING},
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [["valid", "invalid"]]
      }
    }
  },
    {
      indexes: [
      {fields: ["userId", "routeLabel"], unique: true},
      {fields: ["routeLabel"]}
      ]
    })
}

export function makeAssociation (modelCache) {
  var Subscription = modelCache.require('Subscription')
  var User = modelCache.require('User')
  Subscription.belongsTo(User, {
    foreignKey: "userId"
  })
}
