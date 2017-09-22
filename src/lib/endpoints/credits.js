const _ = require('lodash')
const {handleRequestWith} = require('../util/endpoints')

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/credits",
    config: {
      tags: ["api"],
      description: "Get credits for current user",
      auth: {access: {scope: ['user']}}
    },
    handler: handleRequestWith(
      (ignored, request, {models}) => models.Credit.findOne({
        where: {
          userId: request.auth.credentials.userId,
        },
        attributes: ['balance']
      }),
      credits => _.get(credits, 'balance', '0.00')
    )
  })

  next()
}

register.attributes = {
  name: "endpoint-credits"
}
