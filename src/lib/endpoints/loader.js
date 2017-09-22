
export function register (server, options, next) {
  let token = process.env.LOADER_TOKEN


  if (/^[a-zA-Z0-9-]{15,}$/.test(token)) {
    server.route({
      method: "GET",
      path: `/${token}/`,
      config: {
        description: "LoaderIO verification",
        validate: {}
      },
      handler: async function (request, reply) {
        reply(token)
      }
    })
  }

  next()
}

register.attributes = {
  name: "endpoint-loader"
}
