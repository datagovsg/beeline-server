import assert from "assert"
/**
 * The Suggestion data model
 * @param {ModelCache} modelCache
 * @return {Model}
 */
export default function(modelCache) {
  const DataTypes = modelCache.db.Sequelize
  return modelCache.db.define(
    "suggestion",
    {
      board: {
        type: DataTypes.GEOMETRY("POINT"), // eslint-disable-line
        allowNull: false,
      },
      alight: {
        type: DataTypes.GEOMETRY("POINT"), // eslint-disable-line
        allowNull: false,
      },
      time: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      daysMask: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: parseInt("0011111", 2), // Mon-Fri, excluding Sat, Sun
      },

      daysOfWeek: {
        type: DataTypes.VIRTUAL,
        get() {
          const mask = this.getDataValue("daysMask")
          return [
            Boolean(mask & parseInt("0000001", 2)),
            Boolean(mask & parseInt("0000010", 2)),
            Boolean(mask & parseInt("0000100", 2)),
            Boolean(mask & parseInt("0001000", 2)),
            Boolean(mask & parseInt("0010000", 2)),
            Boolean(mask & parseInt("0100000", 2)),
            Boolean(mask & parseInt("1000000", 2)),
          ]
        },
        set(value) {
          assert(
            value.length === 7,
            "daysOfWeek takes an array of exactly 7 booleans"
          )

          const maskValue = [
            Boolean(value[0]) && parseInt("0000001", 2),
            Boolean(value[1]) && parseInt("0000010", 2),
            Boolean(value[2]) && parseInt("0000100", 2),
            Boolean(value[3]) && parseInt("0001000", 2),
            Boolean(value[4]) && parseInt("0010000", 2),
            Boolean(value[5]) && parseInt("0100000", 2),
            Boolean(value[6]) && parseInt("1000000", 2),
          ].reduce((a, b) => a | b, 0)

          this.setDataValue("daysMask", maskValue)
        },
      },

      currentMode: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      userId: {
        type: DataTypes.INTEGER,
        references: {
          model: modelCache.require("User"),
          key: "id",
        },
        allowNull: true,
      },

      /** IFF we allow anonymous non-registered suggestions **/
      email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      ipAddress: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      /** Differentiate if suggestion page is directed from whitelabel sites **/
      referrer: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      travelTime: DataTypes.INTEGER,
    },
    {
      indexes: [{ fields: ["userId"] } /* Necessary for reverse lookup */],
    }
  )
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
  `,
]
