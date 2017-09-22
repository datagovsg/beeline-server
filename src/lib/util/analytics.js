const analyticsPlugin = {
  register: function (server, options, next) {
    server.ext({
      type: 'onPostAuth',
      method: async function (request, reply) {
        if (request.path === '/routes/recent') {
          try {
            var m = server.plugins['sequelize'].models
            // to save last used app name
            if (request.auth.credentials.userId) {
              let userInst = await m.User.findById(request.auth.credentials.userId)
              if (userInst) {
                if (request.headers["beeline-app-name"]) {
                  await userInst.update({
                    lastUsedAppName: request.headers["beeline-app-name"]
                  })
                }
              }
            }
          } catch (error) {
            console.log("ERROR")
            console.log(error)
          }
        }
        return reply.continue()
      }
    })
    next()
  }
}

analyticsPlugin.register.attributes = {
  name: 'analyticsPlugin',
  version: '1.0.0'
}

module.exports = analyticsPlugin
