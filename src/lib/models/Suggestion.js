export default function (modelCache) {
  var DataTypes = modelCache.db.Sequelize
  return modelCache.db.define('suggestion', {
    board: {
      type: DataTypes.GEOMETRY("POINT"),
      allowNull: false
    },
    alight: {
      type: DataTypes.GEOMETRY("POINT"),
      allowNull: false
    },
    time: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    currentMode: {
      type: DataTypes.STRING,
      allowNull: true
    },

    userId: {
      type: DataTypes.INTEGER,
      references: {
        model: modelCache.require('User'),
        key: "id"
      },
      allowNull: true
    },

    /** IFF we allow anonymous non-registered suggestions **/
    email: {
      type: DataTypes.STRING,
      allowNull: true
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true
    },

    /** Differentiate if suggestion page is directed from whitelabel sites **/
    referrer: {
      type: DataTypes.STRING,
      allowNull: true
    },

    travelTime: DataTypes.INTEGER
  },
    {
      indexes: [
     {fields: ["userId"]} /* Necessary for reverse lookup */
      ]
    })
}

export var postSync = [
  `
  CREATE INDEX sugg_board_index ON suggestions
  USING GIST (
  ST_Transform(ST_SetSRID(board, 4326), 3414));
  `,
  `
  CREATE INDEX sugg_alight_index ON suggestions
  USING GIST (
  ST_Transform(ST_SetSRID(alight, 4326), 3414)
  )
  `
]
