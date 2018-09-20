import Joi from "joi"

export const routeSchema = Joi.array()
  .items(
    Joi.object({
      lat: Joi.number(),
      lng: Joi.number(),
      numBoard: Joi.number()
        .integer()
        .min(0),
      numAlight: Joi.number()
        .integer()
        .min(0),
      time: Joi.number().integer(),
      stopId: Joi.number().integer(),
      description: Joi.string(),
      pathToNext: Joi.string().allow(null), // encoded polyline string
    }).unknown()
  )
  .min(2)

/**
 * The Suggestion data model
 * @param {ModelCache} modelCache
 * @return {Model}
 */
export default function(modelCache) {
  const DataTypes = modelCache.db.Sequelize
  return modelCache.db.define("suggestedRoute", {
    seedSuggestionId: DataTypes.INTEGER,
    userId: DataTypes.INTEGER,
    routeId: DataTypes.INTEGER,
    adminEmail: DataTypes.STRING,
    route: {
      type: DataTypes.JSONB,
      set(val) {
        Joi.assert(val, routeSchema)
        this.setDataValue("route", val)
      },
    },
  })
}

/**
 *
 * @param {*} modelCache
 * @return {void}
 */
export function makeAssociation(modelCache) {
  let Suggestion = modelCache.require("Suggestion")
  let SuggestedRoute = modelCache.require("SuggestedRoute")
  let Route = modelCache.require("Route")

  SuggestedRoute.belongsTo(Suggestion, {
    foreignKey: "seedSuggestionId",
    as: "seedSuggestion",
  })
  SuggestedRoute.belongsTo(Route, {
    foreignKey: "routeId",
    as: "crowdstartRoute",
  })
}
