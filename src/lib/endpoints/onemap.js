import axios from 'axios'
import qs from "querystring"
import _ from "lodash"
import assert from "assert"
import Boom from "boom"

var lastToken = {
  iat: 0,
  token: null
}

export function getToken () {
  /* request a token only every 1 hour or so */
  var now = new Date().getTime()

  if (now - lastToken.iat < 3600 * 1000) {
    return lastToken.token
  } else {
    var url = "http://www.onemap.sg/API/services.svc/getToken?" + qs.stringify({
      accessKEY: process.env.ONEMAP_TOKEN,
      v: "3.10",
      type: "compact"
    })

    var thisPromise = axios.get(url)
      .then((response) => {
        return response.data.GetToken[0].NewToken
      })

    lastToken.token = thisPromise
    lastToken.iat = now

    return thisPromise
  }
}

export async function query (path, queryString) {
  var token = await getToken()

  var options = _.extend({}, queryString, {
    token: token
  })

  var response = await axios.get(`http://www.onemap.sg/API/services.svc/${path}?` + qs.stringify(options))

  return response.data
}

export function register (server, options, next) {
  server.route({
    path: "/onemap/{what}",
    method: "GET",
    async handler (request, reply) {
      try {
        var data = await query(request.params.what, request.query)

        reply(data)
      } catch (err) {
        console.error(err)
        reply(Boom.badImplementation(err))
      }
    }
  })
  next()
}

register.attributes = {
  name: "endpoint-onemap"
}
