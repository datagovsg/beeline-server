import axios from 'axios'
import qs from "querystring"
import _ from "lodash"
import assert from "assert"
import Boom from "boom"

var lastToken = {
  exp: 0,
  token: null
}

export async function getToken () {
  var now = new Date().getTime()

  /* 10 minutes to expiry */
  if (lastToken.exp * 1e3 - now > 10 * 60e3) {
    return lastToken.token
  } else {
    var url = 'https://developers.onemap.sg/publicapi/publicsessionid'

    var tokenRequest = axios.get(url).then((response) => {
      lastToken.exp = response.data.expiry_timestamp
      lastToken.token = response.data.access_token
      return response.data.access_token
    })

    return tokenRequest
  }
}

export async function query (path, queryString) {
  var token = await getToken()

  var options = _.extend({}, queryString, {
    token: token
  })

  var response = await axios.get(`https://developers.onemap.sg/publicapi/${path}?` + qs.stringify(options))

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
