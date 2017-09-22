// Test to Investigate
// 4th Apr 2017
// The following test is a version of what is in test/transactionItems.js
// This version triggers the following concurrency error
// while attempting to reduce seatAvailability and insert tickets at the same time
//
// UnhandledPromiseRejectionWarning: Unhandled promise rejection: SequelizeDatabaseError: could not serialize access due to concurrent update
// 2017-04-04 15:13:21 SGT [2881-8] travis@postgres STATEMENT:  UPDATE "trips" SET "seatsAvailable"="seatsAvailable" - 1,"updatedAt"='2017-04-04 07:13:21.227 +00:00' WHERE "id" = '315'
// 2017-04-04 15:13:21 SGT [2883-9] travis@postgres ERROR:  current transaction is aborted, commands ignored until end of transaction block
// 2017-04-04 15:13:21 SGT [2883-10] travis@postgres STATEMENT:  SELECT "id", "date", "capacity", "seatsAvailable", "price", "status", "transportCompanyId", "vehicleId", "driverId", "routeId", "bookingInfo", "createdAt", "updatedAt" FROM "trips" AS "trip" WHERE "trip"."id" IN (315) AND "trip"."seatsAvailable" < 0 LIMIT 1;
// 2017-04-04 15:13:21 SGT [2882-9] travis@postgres ERROR:  current transaction is aborted, commands ignored until end of transaction block
//
// const {db, models: m} = require('../src/lib/core/dbschema')();
// const {defaultErrorHandler, loginAs, randomEmail,
//   randomString, createStripeToken} = require("./test_common");
// import {createUsersCompaniesRoutesAndTrips, companies} from './test_data';
// import {expect, fail} from "code";
// import server from "../src/index"
// import Lab from "lab";
// import Joi from 'joi';
// import _ from 'lodash';
// import * as auth from '../src/lib/core/auth';

// export var lab = Lab.script();

// lab.experiment("TransactionItems", function() {
//   var userInstance, companyInstance, routeInstance, stopInstances, tripInstances;
//   var authHeaders = {};
//   const ticketPrice = '5.00'
//   const ticketsBought = 5
//   var trips = null
//   var testTag;

//   lab.before({timeout: 15000}, async function() {
//     ({userInstance, companyInstance, routeInstance, tripInstances, stopInstances}
//         = await createUsersCompaniesRoutesAndTrips(m));

//     testTag = `test-${Date.now()}`;

//     await routeInstance.update({
//       tags: [testTag]
//     })

//     trips = await Promise.all(
//       new Array(ticketsBought).fill(+ticketPrice).map((price, i) => m.Trip.create({
//         date: `2018-03-0${i + 1}`,
//         capacity: 10,
//         routeId: routeInstance.id,
//         price: price,
//         transportCompanyId: companyInstance.id,
//         tripStops: [
//           { stopId: stopInstances[0].id, canBoard: true, canAlight: true, time: `2018-03-0${i + 1}T08:30:00Z`},
//           { stopId: stopInstances[1].id, canBoard: true, canAlight: true, time: `2018-03-0${i + 1}T08:35:00Z`},
//           { stopId: stopInstances[2].id, canBoard: true, canAlight: true, time: `2018-03-0${i + 1}T08:40:00Z`},
//           { stopId: stopInstances[3].id, canBoard: true, canAlight: true, time: `2018-03-0${i + 1}T09:50:00Z`},
//           { stopId: stopInstances[4].id, canBoard: true, canAlight: true, time: `2018-03-0${i + 1}T09:55:00Z`}
//         ],
//         bookingInfo: {
//           windowType: 'stop',
//           windowSize: 0,
//         }
//       }, {
//         include: [{model: m.TripStop}]
//       }))
//     );

//     var userToken = (await loginAs("user", userInstance.id)).result.sessionToken;
//       authHeaders.user = {authorization: "Bearer " + userToken};

//     var adminToken = (await loginAs("admin", {
//       transportCompanyId: companyInstance.id,
//       permissions: ['refund', 'manage-routes', 'issue-tickets']
//     })).result.sessionToken;
//     authHeaders.admin = {authorization: "Bearer " + adminToken};

//     var superToken = (await loginAs('superadmin')).result.sessionToken
//     authHeaders.super = { authorization: 'Bearer ' + superToken }

//   })

//   lab.afterEach(async () => {
//     for (let trip of trips) {
//       for (let tripStop of trip.tripStops) {
//         await m.Ticket.destroy({
//           where: {
//             boardStopId: tripStop.id
//           }
//         })
//       }
//     }
//   })

//   lab.test('TransactionItems for routeCredits transactions', {timeout: 20000}, async function () {
//     // Pre-made transactions:
//     // buy 1 ticket, paid using routeCredits
//     // buy 2 tickets, 1 paid using routeCredits
//     // buy 2 tickets, paid with money. Refund 1 to credits.
//     // issue free credits
//     // purchase credits with money
//     // 1 failed transaction

//     const userId = userInstance.id;
//     const companyId = companyInstance.id
//     const issueAmt = '5.00'

//     // Create the user credits
//     await m.RouteCredit.destroy({
//       where: {userId, tag: testTag}
//     })
//     // $5 credit...
//     await m.RouteCredit.create({
//       companyId,
//       userId,
//       tag: testTag,
//       balance: '10.00'
//     })

//     const purchaseItems1 = [{
//       tripId: trips[0].id,
//       boardStopId: trips[0].tripStops[0].id,
//       alightStopId: trips[0].tripStops[4].id,
//     }]

//     const purchaseItems2 = [{
//       tripId: trips[1].id,
//       boardStopId: trips[1].tripStops[0].id,
//       alightStopId: trips[1].tripStops[4].id,
//     }, {
//       tripId: trips[2].id,
//       boardStopId: trips[2].tripStops[0].id,
//       alightStopId: trips[2].tripStops[4].id,
//     }]

//     const purchaseItems3 = [{
//       tripId: trips[3].id,
//       boardStopId: trips[3].tripStops[0].id,
//       alightStopId: trips[3].tripStops[4].id,
//     }, {
//       tripId: trips[4].id,
//       boardStopId: trips[4].tripStops[0].id,
//       alightStopId: trips[4].tripStops[4].id,
//     }]

//     const saleResponse1 = await server.inject({
//       method: "POST",
//       url: "/transactions/tickets/payment",
//       payload: {
//         trips: purchaseItems1,
//         creditTag: testTag,
//         stripeToken: await createStripeToken(),
//       },
//       headers: authHeaders.user
//     });
//     expect(saleResponse1.statusCode).to.equal(200);

//     const failedSaleResponse = await server.inject({
//       method: "POST",
//       url: "/transactions/tickets/payment",
//       payload: {
//         trips: purchaseItems2,
//         creditTag: testTag,
//         stripeToken: 'Fake stripe token',
//       },
//       headers: authHeaders.user
//     });
//     expect(failedSaleResponse.statusCode).to.equal(402);

//     const saleResponse2 = await server.inject({
//       method: "POST",
//       url: "/transactions/tickets/payment",
//       payload: {
//         trips: purchaseItems2,
//         creditTag: testTag,
//         stripeToken: await createStripeToken(),
//       },
//       headers: authHeaders.user
//     });
//     expect(saleResponse2.statusCode).to.equal(200);

//     const saleResponse3 = await server.inject({
//       method: "POST",
//       url: "/transactions/tickets/payment",
//       payload: {
//         trips: purchaseItems3,
//         stripeToken: await createStripeToken(),
//       },
//       headers: authHeaders.user
//     });
//     expect(saleResponse3.statusCode).to.equal(200);

//     const saleTIByType = _.groupBy(saleResponse3.result.transactionItems,
//       ti => ti.itemType)
//     expect(saleTIByType.ticketSale).exist()
//     expect(saleTIByType.ticketSale.length).equal(2)

//     const refundResponse = await server.inject({
//       method: "POST",
//       url: `/transactions/tickets/${saleTIByType.ticketSale[0].itemId}/refund/route_pass`,
//       payload: {
//         ticketId: saleTIByType.ticketSale[0].itemId,
//         targetAmt: ticketPrice,
//         creditTag: testTag
//       },
//       headers: authHeaders.super
//     });
//     expect(refundResponse.statusCode).to.equal(200);

//     var compensationResponse = await server.inject({
//       method: "POST",
//       url: "/transactions/route_passes/issue_free",
//       payload: {
//         description: 'Issue 1 Free Pass',
//         userId,
//         amount: issueAmt,
//         routeId: routeInstance.id,
//         tag: testTag
//       },
//       headers: authHeaders.admin
//     });
//     expect(compensationResponse.statusCode).to.equal(200);

//     const purchaseResponse = await server.inject({
//       method: 'POST',
//       url: `/transactions/route_passes/payment`,
//       payload: {
//         value: '5.00',
//         creditTag: testTag,
//         stripeToken: await createStripeToken(),
//         companyId
//       },
//       headers: authHeaders.user
//     })
//     expect(purchaseResponse.statusCode).equal(200);

//     // end setup

//     // Expect:
//     // 7 transactions, of which 5 are returned

//     const txnResponse = await server.inject({
//       method: 'GET',
//       url: `/companies/${companyId}/transactionItems/routeCredits`,
//       headers: authHeaders.admin
//     })
//     expect(txnResponse.statusCode).equal(200);

//     expect(txnResponse.result.length).equal(6);

//     const transactions = txnResponse.result.map(ti => ti.transaction)
//     const txnByType = _.groupBy(transactions, t => t.type)

//     expect(_.keys(txnByType).length).equal(4)
//     expect(txnByType.ticketPurchase).exist()
//     expect(txnByType.ticketPurchase.length).equal(3)
//     expect(txnByType.ticketPurchase.filter(
//       t => t.committed == false).length).equal(1)
//     expect(txnByType.refundToRouteCredit).exist()
//     expect(txnByType.refundToRouteCredit.length).equal(1)
//     expect(txnByType.freeRouteCredit).exist()
//     expect(txnByType.freeRouteCredit.length).equal(1)
//     expect(txnByType.routeCreditPurchase).exist()
//     expect(txnByType.routeCreditPurchase.length).equal(1)

//     const userResponse = await server.inject({
//       method: 'GET',
//       url: `/companies/${companyId}/transactionItems/routeCredits`,
//       headers: authHeaders.user
//     })
//     expect(userResponse.statusCode).equal(403)

//     const noHeaderResponse = await server.inject({
//       method: 'GET',
//       url: `/companies/${companyId}/transactionItems/routeCredits`,
//     })
//     expect(noHeaderResponse.statusCode).equal(403)

//   })

// })
//
