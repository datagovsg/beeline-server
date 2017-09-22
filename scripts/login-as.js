
require('bluebird').config({cancellation: true});
const tc = require("../test/test_common");
const {db, models} = require("../src/lib/core/dbschema")();

if (process.argv.length < 3 ||
  (process.argv[2] != "superadmin" && process.argv.length < 4)) {
  console.error(`
Syntax:

(1) As Driver
export DATABASE_URL=postgres://.../
babel-node login-as.js driver <driverId>

(2) As User
export DATABASE_URL=postgres://.../
babel-node login-as.js user <userId>

(3) As Admin
export DATABASE_URL=postgres://.../
babel-node login-as.js admin <transportCompanyId>

(4) As Superadmin
export DATABASE_URL=postgres://.../
babel-node login-as.js superadmin
`);
  process.exit(1);
}

if (process.argv[2] == "driver") {
  models.Driver.findById(process.argv[3])
  .then((driver) => {
    console.log(driver.makeToken());
  })
  .then(process.exit)
  .then(null, (error) => console.error(error));
} else if (process.argv[2] == "user") {
  models.User.find({
    where: {
      telephone: process.argv[3]
    }
  })
  .then((user) => {
    console.log(user.makeToken());
  })
  .then(process.exit)
  .then(null, (error) => console.error(error));
} else if (process.argv[2] == "admin") {
  tc.loginAs("admin", {
    transportCompanyId: parseInt(process.argv[3])
  }, null)
  .then(response => console.log(response.result.sessionToken))
  .then(process.exit)
  .then(null, (error) => console.error(error));
} else if (process.argv[2] == "superadmin") {
  tc.loginAs("superadmin", {
  }, null)
  .then(response => console.log(response.result.sessionToken))
  .then(process.exit)
  .then(null, (error) => console.error(error));
}
