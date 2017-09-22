import _ from 'lodash'
const {randomSingaporeLngLat} = require("./test_common")

const testMerchantId = process.env.STRIPE_TEST_DESTINATION

/* Test companies */
var testName = "Jin Jia Ho Transport Services Pte Ltd"
module.exports.companies = [
  {
    email: "jinjiaho@example.com",
    name: testName,
    clientSecret: "Secret!",
    clientId: "ID!",
    sandboxSecret: "Sandbox Secret!",
    sandboxId: "Sandbox ID!",
    features: "my features",
    terms: "my terms"
  },
  {
    email: "jinjiahox@example.com",
    name: testName,
    clientSecret: "xSecret!",
    clientId: "xID!",
    sandboxSecret: "xSandbox Secret!",
    sandboxId: "xSandbox ID!",
    features: "xmy features",
    terms: "my xterms",
    id: 100
  },
  {
    email: "testyCompany",
    name: "WaXiTest",
    clientSecret: "testySecret",
    clientId: "testyId",
    sandboxSecret: "testySandySecret",
    sandboxId: "testySandyId",
    features: "testy features",
    terms: "testy terms",
  }
]

module.exports.isTestCompany = {
  name: testName
}
module.exports.users = [
  {
    email: "test@example.com",
    password: "SomeSecretPassword"
  }, {
    email: "test1@example.com",
    password: "OhSoSecretPassword"
  }]
module.exports.isTestUser = {
  email: "test@example.com"
}
module.exports.trips = [
  {
    capacity: 10,
    status: "ACTIVE",
    transportCompanyId: 1,
    driverId: null,
    vehicleId: null,
    date: new Date("2016-02-01T00:00:00Z"),

    tripStops: [
        { stop: { coordinates: {type: "Point", coordinates: [103.41, 1.38]}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.38]}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.39]}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-01T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.50, 1.40]}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-01T08:00:00+0800"}
    ]
  },
  {
    capacity: 10,
    status: "ACTIVE",
    transportCompanyId: 1,
    driverId: null,
    vehicleId: null,
    date: new Date("2016-02-02T00:00:00Z"),

    tripStops: [
        { stop: { coordinates: {type: "Point", coordinates: [103.41, 1.38]}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.38]}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.39]}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-02T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.50, 1.40]}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-02T08:00:00+0800"}
    ]
  },
  {
    capacity: 10,
    status: "ACTIVE",
    transportCompanyId: 1,
    driverId: null,
    vehicleId: null,
    date: new Date("2016-02-03T00:00:00Z"),

    tripStops: [
        { stop: { coordinates: {type: "Point", coordinates: [103.41, 1.38]}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.38]}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.39]}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-03T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.50, 1.40]}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-03T08:00:00+0800"}
    ]
  },
  {
    capacity: 10,
    status: "ACTIVE",
    transportCompanyId: 1,
    driverId: null,
    vehicleId: null,
    date: new Date("2016-02-04T00:00:00Z"),

    tripStops: [
        { stop: { coordinates: {type: "Point", coordinates: [103.41, 1.38]}, description: "Some stop 1"}, canBoard: true, canAlight: false, time: "2016-02-04T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.38]}, description: "Some stop 2"}, canBoard: true, canAlight: false, time: "2016-02-04T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.42, 1.39]}, description: "Some stop 3"}, canBoard: true, canAlight: false, time: "2016-02-04T08:00:00+0800"},
        { stop: { coordinates: {type: "Point", coordinates: [103.50, 1.40]}, description: "Some stop 4"}, canBoard: false, canAlight: true, time: "2016-02-04T08:00:00+0800"}
    ]
  }
]

module.exports.createTripInstancesFrom = async (models, objects, prices) => {
  const {routeInstance, stopInstances} = objects
  const year = new Date().getFullYear() + 1
  const makeDate = i => `${year}-03-0${i + 1}`
  return Promise.all(
    prices.map((price, i) => models.Trip.create({
      date: `${makeDate(i)}`,
      capacity: 10,
      routeId: routeInstance.id,
      price: price,
      tripStops: [
        { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: `${makeDate(i)}T08:30:00Z`},
        { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: `${makeDate(i)}T08:35:00Z`},
        { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: `${makeDate(i)}T08:40:00Z`},

        { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: `${makeDate(i)}T09:50:00Z`},
        { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: `${makeDate(i)}T09:55:00Z`}
      ],
      bookingInfo: {
        windowType: 'stop',
        windowSize: 0,
      }
    }, {
      include: [{model: models.TripStop}]
    }))
  )
}

module.exports.createUsersCompaniesRoutesAndTrips = async function (models, prices = [7.31, 5.27, 6.98, 4.21, 6.52]) {
  const userInstance = await models.User.create({
    email: `testuser${new Date().getTime()}@example.com`,
    name: "Test user",
    telephone: Date.now(),
  })

  const companyInstance = await models.TransportCompany.create({
    name: "Test company",
    clientId: testMerchantId,
    sandboxId: testMerchantId
  })

  // Create stops
  const stopInstances = await Promise.all(
    _.range(0, 8)
    .map((i) => models.Stop.create({
      description: `Test Stop ${i + 1}`,
      coordinates: {
        type: "Point",
        coordinates: randomSingaporeLngLat()
      }
    }))
  )

  // create Route
  const routeInstance = await models.Route.create({
    name: "Test route only",
    from: "Test route From",
    to: "Test route To",
    transportCompanyId: companyInstance.id,
    label: 'XYZ'
  })

  // create some trips...
  const tripInstances = await exports.createTripInstancesFrom(
    models,
    {routeInstance, stopInstances},
    prices
  )

  return {
    userInstance, companyInstance, tripInstances, stopInstances, routeInstance
  }
}

module.exports.destroyUsersCompaniesRoutesAndTrips = (models, userInstance, companyInstance, tripInstances, stopInstances, routeInstance) =>
  async () => {
    try {
      await models.TripStop.destroy({
        where: {
          stopId: {$in: stopInstances.map(i => i.id)},
          tripId: {$in: tripInstances.map(i => i.id)},
        }
      })
      await Promise.all(tripInstances.map(instance => instance.destroy()))
      await routeInstance.destroy()
      await companyInstance.destroy()
      await userInstance.destroy()
    } catch (err) {
      console.error(err.stack)
    }
  }
