import _ from 'lodash';

const {db: sequelize, models} = require('../src/lib/core/dbschema')();

Date.prototype.toLocalString = function () {
  return new Date(this.getTime() - 60000 * this.getTimezoneOffset())
        .toISOString();
};

async function create () {
  try {
    await sequelize.transaction(async txn => {
      var t = {transaction: txn};
      var m = models;
      var transportCompany = await m.TransportCompany.findOne();
      var routes = _.sortBy(await m.Route.findAll(), 'id');
      var stops = _.sortBy(await m.Stop.findAll(), 'id');
            // console.log(transportCompany)
            // console.log(routes.map(x => x.toJSON()))
            // console.log(stops.map(x => x.toJSON()))

      var trips = [];
      var iteration = -1;
      for (var timeSlot = 0; timeSlot < 12; timeSlot = timeSlot + 4) {
              // create up to 100 days into the future?
              // only on weekdays!
        iteration++;
        var startDateInMillsec = new Date("2016-05-20").getTime();
        var i = 0;
        while (true) {
          var day = new Date(startDateInMillsec + 24 * 60 * 60000 * i);
          if (day.getTime() > startDateInMillsec) { break; } // exceed the end date
          i = i + 1;

          let tripZ1A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 20,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot].id, // Tampines,Bedok to zoo
          }, t);

          var tripStops = [
            await models.TripStop.create({
              tripId: tripZ1A.id,
              stopId: stops[0].id, // tampines
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 0, 0),
            }, t),

            await models.TripStop.create({
              tripId: tripZ1A.id,
              stopId: stops[1].id, // Bedok MRT
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 20, 0),
            }, t),

            await models.TripStop.create({
              tripId: tripZ1A.id,
              stopId: stops[3].id, // zoo
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 50, 0),
            }, t),

          ];
          await tripZ1A.setTripStops(tripStops, t);
          tripZ1A.tripStops = tripStops;

          trips.push(tripZ1A);


          let tripZ3A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 20,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot + 2].id, // Sengkang to Zoo
          }, t);

          tripStops = [
                      // zoo stop
            await models.TripStop.create({
              tripId: tripZ3A.id,
              stopId: stops[2].id, // Sengkang
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 0, 0),
            }, t),

                      // tampines stop
            await models.TripStop.create({
              tripId: tripZ3A.id,
              stopId: stops[3].id, // zoo
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 20, 0),
            }, t),

          ];
          await tripZ3A.setTripStops(tripStops, t);
          tripZ3A.tripStops = tripStops;

          trips.push(tripZ3A);
        }
      }
    });
  } catch (err) {
    console.error(err.stack);
  }
}


Promise.resolve(null)
.then(create)
.then(() => {
  process.exit();
})
.catch(err => {
  console.log(err.stack);
  process.exit(1);
});
