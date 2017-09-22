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

      var trips = [];
      var iteration = -1;
      for (var timeSlot = 0; timeSlot < 12; timeSlot = timeSlot + 4) {
        iteration++;
        var startDateInMillsec = new Date("2016-05-26").getTime();
        var endDateInMillsec = new Date("2016-05-27").getTime();
        var i = 0;
        while (true) {
          var day = new Date(startDateInMillsec + 24 * 60 * 60000 * i);
          if (day.getTime() > endDateInMillsec) { break; } // exceed the end date
          i = i + 1;

          let tripZ1A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 22,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot].id, // Bedok, Tampines to Zoo
          }, t);

          var tripStops = [
            await models.TripStop.create({
              tripId: tripZ1A.id,
              stopId: stops[0].id, // Bedok MRT
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 0, 0),
            }, t),
                      // bedok stop
            await models.TripStop.create({
              tripId: tripZ1A.id,
              stopId: stops[1].id, // Tampines
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 20, 0),
            }, t),

                      // zoo stop
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


          let tripZ2A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 22,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot + 1].id, // Zoo to Bedok,Tampines
          }, t);

          tripStops = [
            await models.TripStop.create({
              tripId: tripZ2A.id,
              stopId: stops[3].id, // zoo
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 15, 0, 0),
            }, t),

            await models.TripStop.create({
              tripId: tripZ2A.id,
              stopId: stops[1].id, // Tampines MRT
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 15, 30, 0),
            }, t),

            await models.TripStop.create({
              tripId: tripZ2A.id,
              stopId: stops[0].id, // Bedok
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 15, 50, 0),
            }, t),

          ];
          await tripZ2A.setTripStops(tripStops, t);
          tripZ2A.tripStops = tripStops;

          trips.push(tripZ2A);


          let tripZ3A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 22,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot + 2].id, //  Sengkang to zoo
          }, t);

          tripStops = [

            await models.TripStop.create({
              tripId: tripZ3A.id,
              stopId: stops[2].id, // sengkang
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 0, 0),
            }, t),


            await models.TripStop.create({
              tripId: tripZ3A.id,
              stopId: stops[3].id, // zoo
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 9, 25, 0),
            }, t),

          ];
          await tripZ3A.setTripStops(tripStops, t);
          tripZ3A.tripStops = tripStops;

          trips.push(tripZ3A);

          let tripZ4A = await models.Trip.create({
            date: day.toLocalString().substr(0, 10),
            capacity: 22,
            transportCompanyId: transportCompany.id,
            price: 3,
            routeId: routes[timeSlot + 3].id, // Zoo to Sengkang
          }, t);

          tripStops = [
                      // zoo stop
            await models.TripStop.create({
              tripId: tripZ4A.id,
              stopId: stops[3].id, // zoo
              canBoard: true,
              canAlight: false,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 15, 10, 0),
            }, t),

            await models.TripStop.create({
              tripId: tripZ4A.id,
              stopId: stops[2].id, // Sengkang MRT
              canBoard: false,
              canAlight: true,
              time: new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                                          iteration + 15, 35, 0),
            }, t),

          ];
          await tripZ4A.setTripStops(tripStops, t);
          tripZ4A.tripStops = tripStops;

          trips.push(tripZ4A);
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
