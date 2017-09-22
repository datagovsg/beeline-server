
import {server} from "../index";
import tc from "../test/test_common";
import {tokenFromInstance as makeDriverToken} from "../lib/endpoints/drivers";
import {tokenFromInstance as makeUserToken} from "../lib/endpoints/users";
import querystring from "querystring";
const {db, models} = require("../lib/core/dbschema")();

if (process.argv.length < 4) {
  console.error(`
Syntax:

(1) As Driver
export DATABASE_URL=postgres://.../
babel-node send-trip-to.js <tripId> +65<your phone number>

`);
  process.exit(1);
}

tc.loginAs("superadmin")
.then(response => {
  var headers = {
    authorization: `Bearer ${response.result.sessionToken}`,
  };

  return server.inject({
    url: `/trips/${process.argv[2]}/send_to_phone?` + querystring.stringify({
      telephone: process.argv[3]
    }),
    method: "POST",
    headers: headers,
  });
})
.then(process.exit)
.then(null, (error) => console.error(error));
