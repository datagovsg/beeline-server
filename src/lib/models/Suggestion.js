import Joi from "joi"

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
      boardDesc: {
        type: DataTypes.JSONB,
        set(val) {
          Joi.assert(val, LocationDescriptionSchema)
          this.setDataValue("boardDesc", val)
        },
        allowNull: false,
      },
      alight: {
        type: DataTypes.GEOMETRY("POINT"), // eslint-disable-line
        allowNull: false,
      },
      alightDesc: {
        type: DataTypes.JSONB,
        set(val) {
          Joi.assert(val, LocationDescriptionSchema)
          this.setDataValue("alightDesc", val)
        },
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
          return {
            Mon: Boolean(mask & parseInt("0000001", 2)),
            Tue: Boolean(mask & parseInt("0000010", 2)),
            Wed: Boolean(mask & parseInt("0000100", 2)),
            Thu: Boolean(mask & parseInt("0001000", 2)),
            Fri: Boolean(mask & parseInt("0010000", 2)),
            Sat: Boolean(mask & parseInt("0100000", 2)),
            Sun: Boolean(mask & parseInt("1000000", 2)),
          }
        },
        set(value) {
          Joi.assert(value, DaysOfWeekSchema)

          const maskValue = [
            Boolean(value.Mon) && parseInt("0000001", 2),
            Boolean(value.Tue) && parseInt("0000010", 2),
            Boolean(value.Wed) && parseInt("0000100", 2),
            Boolean(value.Thu) && parseInt("0001000", 2),
            Boolean(value.Fri) && parseInt("0010000", 2),
            Boolean(value.Sat) && parseInt("0100000", 2),
            Boolean(value.Sun) && parseInt("1000000", 2),
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
      classMethods: {
        bindEmailToUserId(email, userId) {
          return this.update(
            { userId },
            {
              where: {
                userId: null,
                email,
              },
            }
          )
        },
      },
    }
  )
}

/**
 *
 * @param {*} modelCache
 * @return {void}
 */
export function makeAssociation(modelCache) {
  let SuggestedRoute = modelCache.require("SuggestedRoute")
  let Suggestion = modelCache.require("Suggestion")

  Suggestion.hasMany(SuggestedRoute, {
    foreignKey: "seedSuggestionId",
    as: "seedSuggestion",
  })
}

export const DaysOfWeekSchema = Joi.object({
  Mon: Joi.bool().required(),
  Tue: Joi.bool().required(),
  Wed: Joi.bool().required(),
  Thu: Joi.bool().required(),
  Fri: Joi.bool().required(),
  Sat: Joi.bool().required(),
  Sun: Joi.bool().required(),
})

export const LocationDescriptionSchema = Joi.object({
  description: Joi.string(),
  postalCode: Joi.number(),
  oneMapAddress: Joi.object(),
})

export const postSync = [
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
