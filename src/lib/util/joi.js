
const Joi = require('joi')

module.exports = Joi.extend([{
  base: Joi.string(),
  name: 'string',
  language: {
    telephone: 'A valid Singapore phone number',
  },
  rules: [
    {
      name: 'telephone',
      validate (params, value, state, options) {
        let noSpaces = value.replace(/\s/g, "")

        const SingaporeNumber = /^(\+65)?([0-9]{8})$/
        const match = noSpaces.match(SingaporeNumber)

        if (!match) {
          return this.createError('string.telephone', {v: value}, state, options)
        } else {
          return "+65" + match[2]
        }
      }
    }
  ]
}])
