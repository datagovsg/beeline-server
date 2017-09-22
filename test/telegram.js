import {expect} from "code"

import Lab from "lab"
const lab = exports.lab = Lab.script()

import {randomEmail} from "./test_common"
import {updateEventSubsToTelegram} from "../src/lib/util/telegram"

const {models} = require("../src/lib/core/dbschema")()

lab.experiment('telegram', () => {
  const telephone = '+6512345678'
  const updateAndValidateAdminInstanceWith = updateFunc => async () => {
    const adminInstance = await models.Admin.create({ telephone, email: randomEmail() })
    const chatId = 7
    await updateEventSubsToTelegram(chatId, updateFunc(adminInstance))
    await adminInstance.reload()
    expect(adminInstance.notes.telegramChatId).equal(chatId)
    await adminInstance.destroy()
  }
  lab.test('upgrade email admin subs to telegram',
    updateAndValidateAdminInstanceWith(adminInstance => ({ email: adminInstance.email })))
  lab.test('upgrade phone admin subs to telegram',
    updateAndValidateAdminInstanceWith(adminInstance => ({ phone: adminInstance.telephone })))

  const updateAndValidateEventSubscriptionWith = (handler, updateFunc) => async () => {
    const eventSub = await models.EventSubscription.create({
      handler, agent: { telephone, email: randomEmail() }
    })
    const chatId = 7
    await updateEventSubsToTelegram(chatId, updateFunc(eventSub))
    await eventSub.reload()
    expect(eventSub.agent.notes.telegramChatId).equal(chatId)
    expect(eventSub.handler).equal('telegram')
    await eventSub.destroy()
  }
  lab.test('upgrade email admin subs to telegram',
    updateAndValidateEventSubscriptionWith('email', e => ({ email: e.agent.email })))
  lab.test('upgrade phone admin subs to telegram',
    updateAndValidateEventSubscriptionWith('sms', e => ({ phone: e.agent.telephone })))
})
