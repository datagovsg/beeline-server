const _ = require("lodash")
const Joi = require("joi")
const Boom = require("boom")
const assert = require('assert')
const leftPad = require('left-pad')
const {getModels, defaultErrorHandler} = require('../util/common')
const auth = require('../core/auth')

const {sendTelegram} = require('../util/telegram')

// // FIXME: Clean this up, and have a more robust error handling mechanism
// // Quick and dirty IPC with the child process
var sendMessage

if (process.env.NO_DAEMON_MONITORING) {
  sendMessage = function () {
    return Promise.resolve(null)
  }
} else {
  var childProcess = require('child_process')
  var monitoringProcess = childProcess.fork(`${__dirname}/../daemons/monitoring`)
  var messageQueues = {}
  var i = 0

  sendMessage = function (method, args) {
    var j = i++
    var promise = new Promise((resolve, reject) => {
      monitoringProcess.send(
        {
          id: j,
          method: method,
          args: args,
        },
        (err) => {
          if (err) {
            console.log("ERROR")
            console.log(err)
            delete messageQueues[j]
            reject()
          }
        })
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
    console.log('MONITORING: KILLPROC')
    monitoringProcess.kill()
    monitoringProcess.on('close', () => process.exit())
  }
  process.on('SIGTERM', killProcesses)
  process.on('SIGINT', killProcesses)
  monitoringProcess.on('message', (msg) => {
    if (msg.telegramChatId) {
      // HACK - only one Telegram bot per
      // process group allowed
      console.log('Sending Telegram on behalf of child')
      sendTelegram(msg.telegramChatId, msg.message)
    } else {
      assert(msg.id in messageQueues)
      messageQueues[msg.id].resolve(msg.result)
    }
  })
  monitoringProcess.on('close', (msg) => {
    console.log('MONITORING: Child process dead')
  })
  process.on('exit', (msg) => {
    console.log('MONITORING: EXITING')
  })
}

sendMessage('startPolling', [60000])

// //

export function register (server, options, next) {
  server.route({
    method: "GET",
    path: "/monitoring",
    config: {
      auth: {
        access: { scope: ['admin', 'superadmin'] }
      },
      tags: ["api"]
    },
    async handler (request, reply) {
      try {
        var result = await sendMessage('getStatus', [])
        var companyIds = await auth.getCompaniesByRole(request.auth.credentials, 'monitor-operations')

        reply(_.pickBy(
          result,
          (value, key) => companyIds.indexOf(value.trip.route.transportCompanyId) !== -1
        ))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  next()
}
register.attributes = {
  name: "endpoint-monitoring"
}
