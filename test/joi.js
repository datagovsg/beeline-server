const Lab = require("lab")
const lab = exports.lab = Lab.script()

const Joi = require("../src/lib/util/joi")
const {expect} = require('code')

lab.experiment("Telehphone number validation", function () {
  const telephoneValidation = Joi.string().telephone()

  lab.test("Valid numbers", async function () {
    expect(Joi.attempt('+6581234567', telephoneValidation)).equal('+6581234567')
    expect(Joi.attempt('+65 8123 4567', telephoneValidation)).equal('+6581234567')
    expect(Joi.attempt('8123 4567', telephoneValidation)).equal('+6581234567')
    expect(Joi.attempt('912 345 67', telephoneValidation)).equal('+6591234567')
  })

  lab.test("Invalid numbers", async function () {
    expect(() => Joi.assert('+65banana', telephoneValidation)).throw()
    expect(() => Joi.assert('+601234567', telephoneValidation)).throw()
    expect(() => Joi.assert('1234567', telephoneValidation)).throw()
  })
})
