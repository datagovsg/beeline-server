/* eslint-disable */

import { sendSMS } from "../util/sms";
import { sendMail } from "../util/email";
import { formatTime24 } from "../util/common";
import { sendTelegram } from "../util/telegram";
import assert from "assert";

export function sms(agent, payload) {
  assert(agent.telephone);

  sendSMS({
    to: agent.telephone,
    from:
      payload.severity && payload.severity >= 6
        ? "BeeEmergncy"
        : payload.severity && payload.severity >= 5
          ? "BeeCritical"
          : "BeelineOps",
    body: `${
      payload.message
    }. Details @ https://monitoring.beeline.sg Sent: ${formatTime24(
      Date.now()
    )}`
  });
}

export function email(agent, payload) {
  assert(agent.email);

  let criticality =
    payload.severity && payload.severity >= 6
      ? "EMERGNCY"
      : payload.severity && payload.severity >= 5 ? "CRITICAL" : "OPS";

  sendMail({
    from: "admin@beeline.sg",
    to: agent.email,
    subject: `[${criticality}] New Beeline Event`,
    text: payload.message
  });
}

// Temporary hard-code on telegram bot
export function telegram(agent, payload) {
  assert(agent.notes.telegramChatId);

  let criticality =
    payload.severity && payload.severity >= 6
      ? "EMERGNCY"
      : payload.severity && payload.severity >= 5 ? "CRITICAL" : "OPS";

  const message = `[${criticality}] ${payload.message} Sent: ${formatTime24(
    Date.now()
  )}`;

  sendTelegram(agent.notes.telegramChatId, message);
}
