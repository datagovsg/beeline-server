var sms = require('../util/sms')
import {formatDate, formatTime24 as formatTime} from '../util/common'

// FIXME:
// We should have proper subscriptions.
// And not all notifications have to go through SMS.
// We could subscribe to Slack / Telegram for example
// and save some money.

/**
  @param options
    @prop severity -- {-1,0,1,2,3,4,5}
    @prop cause -- description of problem
    @prop route -- the route item
    @prop now -- a reference time
    */
export async function processNotifications ([db, m], what) {
  try {
    var {event, now, isNobodyAffected} = what
    var options = {
      severity: event.severity,
      route: event.trip.route,
      cause: event.message,
    }

    now = now || new Date()
    if (!(now instanceof Date)) now = new Date(now)
    var dt = formatDate(now)
    var timeStr = formatTime(now)
    var from = options.severity <= 3 ? 'BeelineOps'
      : options.severity === 4 ? 'BeeCritical' : 'BeeEmrgency'

    // Don't send if 'too minor'
    if (isNobodyAffected) {
      return
    }
    if (options.severity < 3) {
      return
    }

    var message = `${options.cause}.
Svc #${options.route.label}: ${options.route.from} - ${options.route.to} on ${dt}. http://monitoring.beeline.sg`

    // Search for and create the alert if it doesn't already exist
    // Use the dedupkey, but prefix it to denote that it's the "Tr"aditional method
    var [alertInstance, created] = await m.Alert.findCreateFind({
      where: {alertId: 'Tr:' + event.dedupKey()},
      defaults: {alertId: 'Tr:' + event.dedupKey()}
    })

    // Exists -- don't send. Quit.
    if (!created) {
      return
    }

    // Get the list of admins
    var admins = await m.Admin.allToAlertFromCompany(options.route.transportCompanyId)

    // Send the messages
    var sendMessagesPromises = admins.map(admin => sms.sendSMS({
      from: from,
      to: admin.telephone,
      body: message + ` (Sent at ${timeStr})`
    }).catch((err) => {
      console.log(`Ignoring error on sending SMS: ${err}`)
    }))

    await Promise.all(sendMessagesPromises)
  } catch (err) {
    console.log(err)
    console.log(err.stack)
  }
}

export async function warnUsers (rsid, message) {
  throw new Error('unimplemented!')
}
