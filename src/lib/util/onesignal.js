/**
 * Note: there is no official OneSignal library for Node.js
 *
 * There are 3rd party libraries, but I'd rather not rely on them
 */

import axios from 'axios'
import assert from 'assert'
import querystring from 'querystring'

function defaultOptions () {
  assert(process.env.ONESIGNAL_API_KEY)
  assert(process.env.ONESIGNAL_APP_ID)

  return {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`
    }
  }
}

export function createNotification (contents) {
  return axios.post(
    'https://onesignal.com/api/v1/notifications',
    {
      app_id: process.env.ONESIGNAL_APP_ID,
      ...contents
    },
    defaultOptions()
  )
  .then(r => r.data)
}

/**
 * Used only for testing, to verify that `createNotification` has
 * sent out a message
 * @param {*} id
 */
export function viewNotification (id) {
  return axios.get(
    `https://onesignal.com/api/v1/notifications/${id}?` + querystring.stringify({
      app_id: process.env.ONESIGNAL_APP_ID
    }),
    defaultOptions()
  )
  .then(r => r.data)
}

/**
 * Used only for testing, to verify that `createNotification` has
 * sent out a message
 * @param {*} id
 */
export function cancelNotification (id) {
  return axios.delete(
    `https://onesignal.com/api/v1/notifications/${id}?` + querystring.stringify({
      app_id: process.env.ONESIGNAL_APP_ID
    }),
    defaultOptions()
  )
  .then(r => r.data)
}
