import * as events from '../events/events'
import {startPolling} from './scheduler'

const updateInterval = 30 * 60000

function updateEventSubscriptions ({models}) {
  return models.EventSubscription
    .findAll({raw: true})
    .then(events.setSubscriptionList)
}

async function register (server, options, next) {
  const {models, db} = server.plugins.sequelize
  const pollOptions = {
    run: () => updateEventSubscriptions(server.plugins.sequelize),
    name: 'Reload event subscriptions',
    interval: updateInterval,
  }

  await pollOptions.run()
  startPolling(pollOptions)
  server.expose('reloadSubscriptions', pollOptions.run)

  next()
}

register.attributes = {
  name: 'daemon-event-subscriptions',
  dependencies: ['sequelize'],
  version: '1.0.0'
}

module.exports = {
  register,
  updateEventSubscriptions,
  updateInterval
}
