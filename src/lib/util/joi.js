import Joi from "joi"

module.exports = Joi.extend([
  {
    base: Joi.string(),
    name: "string",
    language: {
      telephone: "A valid Singapore phone number",
    },
    rules: [
      {
        name: "telephone",
        validate(params, value, state, options) {
          let noSpaces = value.replace(/\s/g, "")

          const SingaporeNumber = /^(\+65)?([0-9]{8})$/
          const match = noSpaces.match(SingaporeNumber)

          if (!match) {
            return this.createError(
              "string.telephone",
              { v: value },
              state,
              options
            )
          } else {
            return "+65" + match[2]
          }
        },
      },
    ],
  },
  {
    base: Joi.object(),
    name: "latlng",
    language: {
      latlng: "needs to be a GeoJSON point, or LatLng object",
    },
    pre(value, state, options) {
      const tryLatLng = Joi.validate(value, {
        lat: Joi.number(),
        lng: Joi.number(),
      })

      if (!tryLatLng.error) {
        return {
          type: "POINT",
          coordinates: [tryLatLng.value.lng, tryLatLng.value.lat],
        }
      }

      const tryGeoJson = Joi.validate(value, {
        type: Joi.string().valid("Point", "POINT"),
        coordinates: Joi.array()
          .items(Joi.number())
          .max(2)
          .min(2),
      })

      if (!tryGeoJson.error) {
        return { type: "POINT", coordinates: tryGeoJson.value.coordinates }
      }

      // return this.createError("latlng", { v: value }, state, options)
      return tryGeoJson.error
    },
  },
])
