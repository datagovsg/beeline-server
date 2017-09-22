
export function register (server, options, next) {
  var {db, models} = require("./dbschema")()

  server.expose("db", db)
  server.expose("models", models)

  server.ext("onRequest", function (request, reply) {
    server.log(["sequelize", "info"], "Sequelize connection created")
    reply.continue()
  })

  next()
}

register.attributes = {
  name: "sequelize"
}
