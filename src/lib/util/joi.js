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
      latRange: "Latitude must be between {{min}} and {{max}}",
      lngRange: "Longitude must be between {{min}} and {{max}}",
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
          .length(2),
      })

      if (!tryGeoJson.error) {
        return { type: "POINT", coordinates: tryGeoJson.value.coordinates }
      }

      // return this.createError("latlng", { v: value }, state, options)
      return tryGeoJson.error
    },
    rules: [
      {
        name: "latRange",
        params: {
          range: Joi.array()
            .items(
              Joi.number()
                .min(-90)
                .max(90)
            )
            .length(2),
        },
        validate(params, value, state, options) {
          if (
            params.range[0] <= value.coordinates[1] &&
            value.coordinates[1] <= params.range[1]
          ) {
            return value
          }
          return this.createError(
            "latlng.latRange",
            { v: value, min: params.range[0], max: params.range[1] },
            state,
            options
          )
        },
      },
      {
        name: "lngRange",
        params: {
          range: Joi.array()
            .items(
              Joi.number()
                .min(-180)
                .max(180)
            )
            .length(2),
        },
        validate(params, value, state, options) {
          if (
            params.range[0] <= value.coordinates[0] &&
            value.coordinates[0] <= params.range[1]
          ) {
            return value
          }
          return this.createError(
            "latlng.lngRange",
            { v: value, min: params.range[0], max: params.range[1] },
            state,
            options
          )
        },
      },
    ],
  },
])
