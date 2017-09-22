import TelegramBot from 'node-telegram-bot-api'
import _ from "lodash"
import assert from 'assert'

import * as auth from '../core/auth'
import {sendSMS} from './sms'
import {sendMail} from '../util/email'
import Joi from './joi'

const {db, models} = require('../core/dbschema')()

const telephoneSchema = Joi.string().telephone()

const EMAIL_REGEX = /^.+@.+(\..+)+$/

const WELCOME_MESSAGE = `
Welcome to the Beeline Server monitoring bot!
To receive notifications from me, tell your admin
to use your chat id to set up Telegram notifications.
`

const ADVANCED_WELCOME_MESSAGE = `
For advanced users, if you know what you are doing,
share your contact with me using the button below, or type in your email address.
Your contact will be looked up, and if present, you will receive notifications via Telegram.

You should ONLY do this if you REALLY know what you are doing.
`

const CONFIRM_MESSAGE = `
A confirmation code has been sent to the contact.
Please enter it here to verify that you control this contact.
Say /resend or /quit to resend or start this process again.
`

const options = {
  "parse_mode": "Markdown",
  "reply_markup": {
    "one_time_keyboard": true,
    "keyboard": [
      [{ text: "Share contact now", request_contact: true }]
    ]
  }
}

const token = process.env.TELEGRAM_API_TOKEN
console.log('Initializing Telegram...')
const bot = token ? new TelegramBot(token, {polling: true}) : undefined

if (bot) {
  bot.on('text', welcome)
} else {
  console.log(`TELEGRAM_API_TOKEN is not set, notifications via Telegram disabled`)
}

export function sendTelegram (chatId, message) {
  if (bot) {
    bot.sendMessage(chatId, message)
  }
}

const ongoingChats = {}

async function welcome ({chat}) {
  const chatId = chat.id
  if (!ongoingChats[chatId]) {
    await bot.sendMessage(chatId, WELCOME_MESSAGE)
    await bot.sendMessage(chatId, `Your Telegram chat id is ${chatId}`)
    // bot
    //   .sendMessage(chatId, ADVANCED_WELCOME_MESSAGE, options)
    //   .then(() => bot.on('message', registerContact(chatId)))
    //   .then(() => (ongoingChats[chatId] = true));
  }
}

function registerContact (chatId) {
  const callback = ({chat, contact, text}) => {
    if (chat.id === chatId && (contact || EMAIL_REGEX.test(text))) {
      bot.removeListener('message', callback)
      const rawPhone = contact ? contact.phone_number : undefined
      try {
        const phone = rawPhone
          ? Joi.attempt(
            rawPhone.startsWith('+') ? rawPhone : '+' + rawPhone,
            telephoneSchema
          )
          : undefined
        const email = EMAIL_REGEX.test(text) ? text : undefined
        verifyOwnership(chatId, {phone, email})
      } catch (e) {
        console.error(e)
        bot.sendMessage(chatId, 'This phone number is invalid! Starting over!')
        delete ongoingChats[chatId]
        welcome({ chat: {id: chatId} })
      }
    }
  }
  return callback
}

async function verifyOwnership (chatId, {phone, email}) {
  try {
    assert(phone || email)
    const code = await sendVerificationCode({phone, email})
    await bot.sendMessage(chatId, CONFIRM_MESSAGE)
    respondToVerification(chatId, code, {phone, email})
  } catch (e) {
    console.error(e)
    bot.sendMessage(chatId, 'Failed to send verification code! Starting over!')
    delete ongoingChats[chatId]
    welcome({ chat: {id: chatId} })
  }
}

async function sendVerificationCode ({phone, email}) {
  const randomCode = auth.randomNDigits(6)
  const sendCode = phone
    ? sendSMS({
      to: phone,
      from: 'BeelineOps',
      body: `${randomCode} is your ops verification code`,
    })
    : sendMail({
      from: 'admin@beeline.sg',
      to: email,
      subject: `Two-factor verification code for Beeline operations`,
      text: `${randomCode} is your ops verification code`
    })
  return sendCode.then(() => randomCode)
}

function respondToVerification (chatId, code, {phone, email}) {
  const callback = ({chat, text}) => {
    if (chat.id === chatId) {
      if (text === '/resend') {
        bot.removeListener('text', callback)
        verifyOwnership(chatId, {phone, email})
      } else if (text === '/quit') {
        bot.removeListener('text', callback)
        delete ongoingChats[chatId]
        welcome({ chat: {id: chatId} })
      } else if (text === code) {
        bot.removeListener('text', callback)
        updateEventSubsToTelegram(chatId, {phone, email})
          .then(() => bot.sendMessage(chatId, 'Success! You will now receive notifications through Telegram'))
          .then(() => delete ongoingChats[chatId])
      } else {
        bot.sendMessage(chatId, 'Verification failed! Please try again, /resend or /quit')
      }
    }
  }
  bot.on('text', callback)
}

export async function updateEventSubsToTelegram (chatId, {phone, email}) {
  return db.transaction(async transaction => {
    // update admins to include telegram chat id in notes
    const admins = await models.Admin.findAll({
      where: email ? { email } : { telephone: phone },
      transaction,
    })
    await Promise.all(admins.map(admin => {
      const notes = {
        ...(admin.notes || {}),
        telegramChatId: chatId,
      }
      return admin.update({ notes, transaction })
    }))
    // TODO: update event subs that refer to affected admins

    // update event subs that contain the relevant email or phone number
    const subs = await models.EventSubscription.findAll({
      where: email
        ? { handler: 'email', agent: { email }}
        : { $and: [{ handler: 'sms' }, db.where(db.fn('replace', db.literal("(agent->>'telephone')::text"), ' ', ''), phone)]},
      transaction,
    })

    await Promise.all(subs.map(sub => {
      const agent = _.merge({}, sub.agent, { notes: { telegramChatId: chatId } })
      return sub.update({ agent, handler: 'telegram', transaction })
    }))
  })
}
