const {conductSmokeTestAndEmail} = require('../util/smoketest')
const {startPolling} = require('./scheduler')

async function register (server, options, next) {
  if (!process.env.NO_DAEMON_MONITORING) {
    const {models, db} = server.plugins.sequelize
    const options = {
      run: () => conductSmokeTestAndEmail(db),
      name: 'Smoke Test',
      interval: 24 * 60 * 60000,
    }

    await options.run()
    startPolling(options)
  }
  next()
}

register.attributes = {
  name: 'daemon-smoketest',
  dependencies: ['sequelize'],
  version: '1.0.0'
}

module.exports = {register}
