const _ = require("lodash")
const assert = require("assert")
const { defaultErrorHandler } = require("../util/common")
const auth = require("../core/auth")

let sendMessage

if (process.env.NO_DAEMON_MONITORING) {
  sendMessage = function() {
    return Promise.resolve(null)
  }
} else {
  let childProcess = require("child_process")
  let monitoringProcess = childProcess.fork(
    `${__dirname}/../daemons/monitoring`
  )
  let messageQueues = {}
  let i = 0

  sendMessage = function(method, args) {
    let j = i++
    let promise = new Promise((resolve, reject) => {
      monitoringProcess.send(
        {
          id: j,
          method: method,
          args: args,
        },
        err => {
          if (err) {
            console.warn("ERROR")
            console.warn(err)
            delete messageQueues[j]
            reject()
          }
        }
      )
      messageQueues[j] = {
        resolve: resolve,
      }
    })
    promise.then(() => {
      delete messageQueues[j]
    })
    return promise
  }
  const killProcesses = () => {
    console.warn("MONITORING: KILLPROC")
    monitoringProcess.kill()
    monitoringProcess.on("close", () => process.exit())
  }
  process.on("SIGTERM", killProcesses)
  process.on("SIGINT", killProcesses)
  monitoringProcess.on("message", msg => {
    assert(msg.id in messageQueues)
    messageQueues[msg.id].resolve(msg.result)
  })
  monitoringProcess.on("close", msg => {
    console.warn("MONITORING: Child process dead")
  })
  process.on("exit", msg => {
    console.warn("MONITORING: EXITING")
  })
}

sendMessage("startPolling", [60000])

export function register(server, options, next) {
  // eslint-disable-line
  server.route({
    method: "GET",
    path: "/monitoring",
    config: {
      auth: {
        access: { scope: ["admin", "superadmin"] },
      },
      tags: ["api", "admin"],
    },
    async handler(request, reply) {
      try {
        let result = await sendMessage("getStatus", [])
        let companyIds = await auth.getCompaniesByRole(
          request.auth.credentials,
          "monitor-operations"
        )

        reply(
          _.pickBy(
            result,
            (value, key) =>
              companyIds.indexOf(value.trip.route.transportCompanyId) !== -1
          )
        )
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    },
  })

  next()
}
register.attributes = {
  name: "endpoint-monitoring",
}
