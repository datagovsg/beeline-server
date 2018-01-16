const Lab = require("lab")
const {expect} = require("code")
const server = require("../src/index.js")
const {createStripeToken, cleanlyDeleteUsers} = require("./test_common")
const {models} = require("../src/lib/core/dbschema")()

const lab = exports.lab = Lab.script()

let createMasterStripeToken = async function () {
  return createStripeToken("5555555555554444")
}


lab.experiment("Payment info manipulation", function () {
  lab.before({timeout: 10000}, function (done) {
    if (server.info.started) {
      return done()
    } else {
      server.on('start', () => done())
    }
  })

  lab.test('CRUD Payment info', {timeout: 20000}, async function () {
    /* Cleanly delete the user */
    await cleanlyDeleteUsers({
      telephone: '+6581001860',
    })

    const userInst = await models.User.create({
      telephone: '+6581001860',
    })
    const headers = {
      authorization: `Bearer ${userInst.makeToken()}`,
    }

    // get the card details... should have nothing
    const getResponse = await server.inject({
      method: 'GET',
      url: `/users/${userInst.id}/creditCards`,
      headers,
    })
    expect(getResponse.statusCode).equal(200)
    expect(getResponse.result).not.exist()

    // Insert some credit card details
    const postResponse = await server.inject({
      method: 'POST',
      url: `/users/${userInst.id}/creditCards`,
      headers,
      payload: {
        stripeToken: await createStripeToken(),
      },
    })
    expect(postResponse.statusCode).equal(200)
    expect(postResponse.result.sources.data[0]).exist()
    expect(postResponse.result.sources.data[0].last4).equal('4242')
    expect(postResponse.result.sources.data.length).equal(1)


    // Update with another card
    const putResponse = await server.inject({
      method: 'POST',
      url: `/users/${userInst.id}/creditCards/replace`,
      headers,
      payload: {
        stripeToken: await createMasterStripeToken(),
      },
    })
    expect(putResponse.statusCode).equal(200)
    expect(putResponse.result.sources.data[0]).exist()
    expect(putResponse.result.sources.data[0].last4).equal('4444')
    expect(postResponse.result.sources.data.length).equal(1)


    // get the card details... should have something now
    const getResponse2 = await server.inject({
      method: 'GET',
      url: `/users/${userInst.id}/creditCards`,
      headers,
    })
    expect(getResponse2.statusCode).equal(200)
    expect(getResponse2.result).exist()
    expect(getResponse2.result.sources.data[0].last4).equal('4444')
    expect(postResponse.result.sources.data.length).equal(1)


    // Delete card details
    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/users/${userInst.id}/creditCards/${getResponse2.result.sources.data[0].id}`,
      headers,
    })
    expect(deleteResponse.statusCode).equal(200)
    expect(deleteResponse.result).exist()
    expect(deleteResponse.result.sources.data[0]).not.exist()
  })
})
