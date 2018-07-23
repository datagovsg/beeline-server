import Lab from 'lab'
export const lab = Lab.script()

const Joi = require("../src/lib/util/joi")
import {expect} from 'code'

lab.experiment("Telephone number validation", function () {
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

lab.experiment("Lat-Lng Validation", function () {
  const schema = Joi.latlng()

  lab.test("LatLng is converted to GeoJson", async function () {
    expect(Joi.attempt({lat: 1.38, lng: 103.8}, schema))
      .equal({type: 'POINT', coordinates: [103.8, 1.38]})
  })

  lab.test("GeoJson is accepted too", async function () {
    expect(Joi.attempt({type: 'Point', coordinates: [103.8, 1.38]}, schema))
      .equal({type: 'POINT', coordinates: [103.8, 1.38]})
    expect(Joi.attempt({type: 'POINT', coordinates: [103.8, 1.38]}, schema))
      .equal({type: 'POINT', coordinates: [103.8, 1.38]})
  })

  lab.test("Range limitations", async function () {
    expect(() => Joi.attempt({lat: 1.38, lng: 103.8}, schema.latRange([0, 1]))).throws()
    expect(() => Joi.attempt({lat: 1.38, lng: 103.8}, schema.latRange([1, 2]))).not.throws()

    expect(() => Joi.attempt({lat: 1.38, lng: 103.8}, schema.lngRange([100, 102]))).throws()
    expect(() => Joi.attempt({lat: 1.38, lng: 103.8}, schema.lngRange([102, 104]))).not.throws()
  })
})
