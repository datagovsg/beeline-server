/* eslint no-await-in-loop: 0 */

import {resetRegions} from './resetRegions';

const {
  db: sequelize,
  models,
  syncTasks,
  postSyncTasks
} = require('../src/lib/core/dbschema')();

const toLocalString = date =>
  new Date(date.getTime() - 60000 * date.getTimezoneOffset()).toISOString();

async function createTables () {
  await sequelize.transaction(async txn => {
    var t = {
      transaction: txn
    };

    await sequelize.query('create extension if not exists postgis', t);

    for (let task of syncTasks) {
      await task(txn);
    }

    for (let task of postSyncTasks) {
      await sequelize.query(task, t);
    }
  });
}

async function createRoutesCompaniesAndTrips () {
  try {
    await sequelize.transaction(async txn => {
      var t = {
        transaction: txn
      };
      var m = models;

      // create transport companies
      await models.TransportCompany.create({
        name: 'Acme Transport Pte Ltd',
        email: 'acme@beeline.sg',
        contactNo: '+6561234567',
        clientId: 'acct_175v25DZoNqbBFpL',
        sandboxId: 'acct_175v25DZoNqbBFpL',
        clientSecret: 'acme-client-id',
      }, t);

      await models.TransportCompany.create({
        name: 'Beng Buses Pte Ltd',
        email: 'beng@beeline.sg',
        contactNo: '+6561234567',
        clientId: 'acct_17kT9qIjIDWmRbDI',
        sandboxId: 'acct_175v25DZoNqbBFpL',
        clientSecret: 'beng-client-id',
      }, t);

      // create routes
      var routes = [
        await models.Route.create({
          name: 'Sample Route 1',
          label: 'Y2H',
          from: 'Sample Route 1 From',
          to: 'Sample Route 1 To',
          path: ([{
            "lat": 1.4184647000387582,
            "lng": 103.82732391357422
          }, {
            "lat": 1.4006173190275337,
            "lng": 103.82732391357422
          }, {
            "lat": 1.3841426927920155,
            "lng": 103.83110046386719
          }, {
            "lat": 1.3841426927920155,
            "lng": 103.84380340576172
          }, {
            "lat": 1.3824265792866532,
            "lng": 103.85478973388672
          }, {
            "lat": 1.3614898951040653,
            "lng": 103.86920928955078
          }, {
            "lat": 1.3439853145503438,
            "lng": 103.86886596679688
          }, {
            "lat": 1.3299129136379466,
            "lng": 103.86268615722656
          }, {
            "lat": 1.3216753733779616,
            "lng": 103.8534164428711
          }, {
            "lat": 1.3158404324848239,
            "lng": 103.84157180786133
          }, {
            "lat": 1.3065731453895093,
            "lng": 103.83504867553711
          }, {
            "lat": 1.2967909719264816,
            "lng": 103.83590698242188
          }, {
            "lat": 1.2899262662028559,
            "lng": 103.83796691894531
          }, {
            "lat": 1.2810021210896474,
            "lng": 103.82955551147461
          }, {
            "lat": 1.2761967992944656,
            "lng": 103.82543563842773
          }, {
            "lat": 1.2789426985646888,
            "lng": 103.81616592407227
          }]),
        }, t),
        await models.Route.create({
          name: 'Sample Route 1',
          label: 'C2N',
          path: ([{
            "lat": 1.3175565929906294,
            "lng": 104.01803970336914
          }, {
            "lat": 1.3163552807606236,
            "lng": 104.01031494140625
          }, {
            "lat": 1.3122364915812077,
            "lng": 104.0049934387207
          }, {
            "lat": 1.3112067932257883,
            "lng": 104.00070190429688
          }, {
            "lat": 1.3156688163692951,
            "lng": 103.99246215820312
          }, {
            "lat": 1.3199592157121878,
            "lng": 103.98199081420898
          }, {
            "lat": 1.326566416213724,
            "lng": 103.98138999938965
          }, {
            "lat": 1.3273386852522384,
            "lng": 103.97838592529297
          }, {
            "lat": 1.3248502619319968,
            "lng": 103.9742660522461
          }, {
            "lat": 1.3286257997803992,
            "lng": 103.9632797241211
          }, {
            "lat": 1.3316290644037232,
            "lng": 103.95564079284668
          }, {
            "lat": 1.339866571419482,
            "lng": 103.94577026367188
          }, {
            "lat": 1.3462162975139111,
            "lng": 103.69102478027344
          }, {
            "lat": 1.3499918024921078,
            "lng": 103.68759155273438
          }, {
            "lat": 1.353424074657765,
            "lng": 103.68621826171875
          }, {
            "lat": 1.3522227799517252,
            "lng": 103.67883682250977
          }, {
            "lat": 1.3484472784360075,
            "lng": 103.67712020874023
          }, {
            "lat": 1.3481040507348487,
            "lng": 103.68021011352539
          }, {
            "lat": 1.3498201887565244,
            "lng": 103.68501663208008
          }]),
        }, t),
      ];

      // Stops...
      var stops = [
        // Yishun ones
        await models.Stop.create({
          description: 'Yishun 1',
          road: 'Yishun Road 1',
          postcode: '333331',
          label: '333331',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.82968425750732, 1.4302627730720257]
          },
        }, t),

        await models.Stop.create({
          description: 'Yishun 2',
          road: 'Yishun Road 2',
          postcode: '333331',
          label: '333331',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.83972644805908, 1.4294905374141709]
          },
        }, t),

        await models.Stop.create({
          description: 'Yishun 3',
          road: 'Yishun Road 3',
          postcode: '333331',
          label: '333331',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.83981227874756, 1.4241706847209448]
          },
        }, t),

        await models.Stop.create({
          description: 'Yishun 4',
          road: 'Yishun Road 4',
          postcode: '333331',
          label: '333331',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.8356065750122, 1.4226691111719705]
          },
        }, t),

        await models.Stop.create({
          description: 'Yishun 5',
          road: 'Yishun Road 5',
          postcode: '333331',
          label: '333331',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.83457660675049, 1.4191511350319146]
          },
        }, t),

        // Changi?
        // [{"type":"Point","coordinates":[104.01602268218994,1.3114213137514301]},{"type":"Point","coordinates":[104.01677370071411,1.3166341568656237]},{"type":"Point","coordinates":[104.00934934616089,1.3162265687016448]},{"type":"Point","coordinates":[104.00289058685303,1.3120434231718532]},{"type":"Point","coordinates":[103.99563789367676,1.3142100789106437]}]
        await models.Stop.create({
          description: 'Changi 1',
          road: 'Changi Road 1',
          postcode: '555551',
          label: '555551',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [104.01602268218994, 1.3114213137514301]
          },
        }, t),

        await models.Stop.create({
          description: 'Changi 2',
          road: 'Changi Road 2',
          postcode: '555551',
          label: '555551',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [104.01677370071411, 1.3166341568656237]
          },
        }, t),

        await models.Stop.create({
          description: 'Changi 3',
          road: 'Changi Road 3',
          postcode: '555551',
          label: '555551',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [104.00934934616089, 1.3162265687016448]
          },
        }, t),

        await models.Stop.create({
          description: 'Changi 4',
          road: 'Changi Road 4',
          postcode: '555551',
          label: '555551',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [104.00289058685303, 1.3120434231718532]
          },
        }, t),


        await models.Stop.create({
          description: 'Changi 5',
          road: 'Changi Road 5',
          postcode: '555551',
          label: '555551',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.99563789367676, 1.3142100789106437]
          },
        }, t),


        // NTU
        // [{"type":"Point","coordinates":[103.67913722991943,1.3416685223925935]},{"type":"Point","coordinates":[103.67849349975586,1.3457872624870435]},{"type":"Point","coordinates":[103.6785364151001,1.350935677821201]},{"type":"Point","coordinates":[103.6831283569336,1.3542821419406395]},{"type":"Point","coordinates":[103.68510246276855,1.3494340578071855]}]
        await models.Stop.create({
          description: 'NTU 1',
          road: 'NTU Road 1',
          postcode: '444441',
          label: '444441',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.67913722991943, 1.3416685223925935]
          },
        }, t),

        await models.Stop.create({
          description: 'NTU 2',
          road: 'NTU Road 2',
          postcode: '444441',
          label: '444441',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.67849349975586, 1.3457872624870435]
          },
        }, t),

        await models.Stop.create({
          description: 'NTU 3',
          road: 'NTU Road 3',
          postcode: '444441',
          label: '444441',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.6785364151001, 1.350935677821201]
          },
        }, t),

        await models.Stop.create({
          description: 'NTU 4',
          road: 'NTU Road 4',
          postcode: '444441',
          label: '444441',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.6831283569336, 1.3542821419406395]
          },
        }, t),


        await models.Stop.create({
          description: 'NTU 5',
          road: 'NTU Road 5',
          postcode: '444441',
          label: '444441',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.68510246276855, 1.3494340578071855]
          },
        }, t),

        // Harbourfront
        // [{"type":"Point","coordinates":[103.80715370178223,1.2712627541807724]},{"type":"Point","coordinates":[103.81131649017334,1.2703617536190732]},{"type":"Point","coordinates":[103.81397724151611,1.269031704596658]},{"type":"Point","coordinates":[103.81595134735107,1.267572940366298]},{"type":"Point","coordinates":[103.82238864898682,1.265599316864401]}]
        await models.Stop.create({
          description: 'Harbourfront 1',
          road: 'Harbourfront Road 1',
          postcode: '666661',
          label: '666661',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.80715370178223, 1.2712627541807724]
          },
        }, t),

        await models.Stop.create({
          description: 'Harbourfront 2',
          road: 'Harbourfront Road 2',
          postcode: '666661',
          label: '666661',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.81131649017334, 1.2703617536190732]
          },
        }, t),

        await models.Stop.create({
          description: 'Harbourfront 3',
          road: 'Harbourfront Road 3',
          postcode: '666661',
          label: '666661',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.81397724151611, 1.269031704596658]
          },
        }, t),

        await models.Stop.create({
          description: 'Harbourfront 4',
          road: 'Harbourfront Road 4',
          postcode: '666661',
          label: '666661',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.81595134735107, 1.267572940366298]
          },
        }, t),


        await models.Stop.create({
          description: 'Harbourfront 5',
          road: 'Harbourfront Road 5',
          postcode: '666661',
          label: '666661',
          type: 'RandomPoint',
          coordinates: {
            "type": "Point",
            "coordinates": [103.82238864898682, 1.265599316864401]
          },
        }, t),
      ];

      // Trips... oh my god. Let's figure out how to deal with missing stops
      // in the future
      var trips = [];

      // create up to 100 days into the future?
      // only on weekdays!
      async function createTrips (routeId, pickupStopOffset, alightStopOffset, pickupHour, alightHour) {
        var today = new Date();
        for (var i = 0; i < 100; i++) {
          var day = new Date(today.getTime() + 24 * 60 * 60000 * i);
          if (day.getDay() === 0 || day.getDay() === 6) { continue; }

          let trip = await models.Trip.create({
            date: toLocalString(day).substr(0, 10),
            capacity: 10,
            seatsAvailable: 10,
            price: Math.floor(Math.random() * 4) + 5,
            routeId: routes[0].id, // The North-South route
          }, t);

          var tripStops = [
            // Yishun stops
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[0].id,
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                8, 0, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[1].id,
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                8, 2, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[2].id,
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                8, 4, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[3].id,
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                8, 6, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[4].id,
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                8, 5, 0),
            }, t),
            // Harburfront stops
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[15 + 0].id,
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                9, 0, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[15 + 1].id,
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                9, 2, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[15 + 2].id,
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                9, 4, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[15 + 3].id,
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                9, 6, 0),
            }, t),
            await models.TripStop.create({
              tripId: trip.id,
              stopId: stops[15 + 4].id,
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                9, 5, 0),
            }, t),
          ];
          await trip.setTripStops(tripStops, t);
          trip.tripStops = tripStops;

          trips.push(trip);
        }
      }

      await createTrips(routes[0].id, 0, 15, 8, 9);

      // East-West trips
      await createTrips(routes[1].id, 5, 10, 7, 10);

      // User data...
      var user = await models.User.create({
        email: 'testuser@example.com',
        name: 'Test User Tan',
        telephone: '98888888',
      }, t);

      // Random tickets...
      await models.Transaction.create({
        transactionItems: [{
          itemType: 'ticketSale',
          ticketSale: {
            userId: user.id,
            boardStopId: trips[10].tripStops[0].id,
            alightStopId: trips[10].tripStops[5].id,
            status: 'valid',
          },
          credit: trips[10].price,
        }, {
          itemType: 'ticketSale',
          ticketSale: {
            userId: user.id,
            boardStopId: trips[11].tripStops[3].id,
            alightStopId: trips[11].tripStops[6].id,
            status: 'valid',
          },
          credit: trips[11].price,
        }, {
          itemType: 'ticketSale',
          ticketSale: {
            userId: user.id,
            boardStopId: trips[12].tripStops[4].id,
            alightStopId: trips[12].tripStops[9].id,
            status: 'valid',
          },
          credit: trips[12].price,
        }, {
          itemType: 'account',
          account: {
            name: 'Test account',
            amount: trips[10].priceF + trips[11].priceF + trips[12].priceF,
          },
          debit: trips[10].priceF + trips[11].priceF + trips[12].priceF,
        }

        ],
        committed: true,

      }, {
        transaction: txn,
        include: [{
          model: models.TransactionItem,
          include: [{
            model: m.Account,
            as: 'account'
          }, {
            model: m.Ticket,
            as: 'ticketSale'
          }],
        }],

      });
    });
  } catch (err) {
    console.error(err.stack);
  }
}

async function createDrivers () {
  try {
    var m = models;

    await sequelize.transaction(async t => {
      await m.Driver.sync({
        transaction: t
      });
      await m.Vehicle.sync({
        transaction: t
      });
      await m.DriverCompany.sync({
        transaction: t
      });

      var drivers = [
        await m.Driver.create({
          name: 'Lim Ah One',
          telephone: '+6582981261',
        }, {transaction: t}),
        await m.Driver.create({
          name: 'Tan Ah Two',
          telephone: '+6588888888',
        }, {transaction: t}),
        await m.Driver.create({
          name: 'Ong Ah Three',
          telephone: '+6598989898',
        }, {transaction: t}),
        await m.Driver.create({
          name: 'Ahmad Empat',
          telephone: '+6587888887',
        }, {transaction: t}),
        await m.Driver.create({
          name: 'Ali Lima',
          telephone: '+6598881111',
        }, {transaction: t}),
      ];

      var companies = await m.TransportCompany.findAll({
        transaction: t
      });
      await drivers[0].addTransportCompany(companies[0], {
        transaction: t
      });
      await drivers[0].addTransportCompany(companies[1], {
        transaction: t
      });
      await drivers[1].addTransportCompany(companies[0], {
        transaction: t
      });

      var vehicles = [
        await m.Vehicle.create({
          vehicleNumber: 'SJA1111X',
          driverId: drivers[0].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJA1111X',
          driverId: drivers[1].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJB2222X',
          driverId: drivers[2].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJB2222X',
          driverId: drivers[3].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJC3333X',
          driverId: drivers[1].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJD4444X',
          driverId: drivers[3].id,
        }, {
          transaction: t
        }),
        await m.Vehicle.create({
          vehicleNumber: 'SJE5555X',
          driverId: drivers[4].id,
        }, {
          transaction: t
        }),
      ];

      var allTrips = await m.Trip.findAll({
        transaction: t,
      });
      for (let trip of allTrips) {
        var randomVehicle = vehicles[Math.floor(Math.random() * vehicles.length)];
        trip.vehicleId = randomVehicle.id;
        trip.driverId = randomVehicle.driverId;
        await trip.save({
          transaction: t
        });
      }
    });
  } catch (err) {
    console.log(err.stack);
  }
}

async function createPassengers () {
  try {
    var m = models;


    await sequelize.transaction(async t => {
      await m.User.sync({
        transaction: t
      });

      var users = [
        await m.User.create({
          email: 'testuser2@example.com',
          name: 'Test User Sim',
          telephone: '98881234',
        }, {
          transaction: t
        }),
        await m.User.create({
          email: 'testuser3@example.com',
          name: 'Test User Lee',
          telephone: '98884567',
        }, {
          transaction: t
        }),
        await m.User.create({
          email: 'testuser4@example.com',
          name: 'Test User Sun',
          telephone: '98885678',
        }, {
          transaction: t
        }),
        await m.User.create({
          email: 'testuser5@example.com',
          name: 'Test User Tay',
          telephone: '98881357',
        }, {
          transaction: t
        }),
        await m.User.create({
          email: 'testuser6@example.com',
          name: 'Test User Lim',
          telephone: '98882468',
        }, {
          transaction: t
        }),
      ];


      var allTrips = await m.Trip.findAll({
        include: [{
          model: m.TripStop,
        }],
        transaction: t,
        order: [
          [m.TripStop, 'time', 'ASC']
        ]
      });
      for (let trip of allTrips) {
        var numPassengersToAdd = Math.floor(Math.random() * trip.capacity * 0.7);

        for (let i = 0; i < numPassengersToAdd; i++) {
          await m.Ticket.create({
            userId: users[Math.floor(Math.random() * users.length)].id,
            boardStopId: trip.tripStops[0].id,
            alightStopId: trip.tripStops[5].id,
            status: 'valid',
          }, {
            transaction: t
          });
        }
      }
    });
  } catch (err) {
    console.log(err.stack);
    throw err;
  }
}

if (require.main === module) {
  const dbInit = Promise.resolve(null)
    .then(createTables)
    .then(resetRegions);

  if (!process.env.SCHEMA_ONLY) {
    dbInit
      .then(createRoutesCompaniesAndTrips)
      .then(createDrivers)
      .then(createPassengers);
  }

  dbInit
    .then(() => {
      process.exit();
    })
    .catch(err => {
      console.log(err.stack);
      process.exit(1);
    });
}
