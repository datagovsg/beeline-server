import {SMTPServer} from "smtp-server"
import SMTPConnection from "smtp-connection"
import fs from "fs"
import Q from "q"
import _ from "lodash"
import nodemailer from 'nodemailer'
import BlueBird from 'bluebird'
const config = require("../../config")

export async function send (envelope, message) {
  if (!(process.env.SMTP_HOST && process.env.SMTP_PORT &&
    process.env.SMTP_USER && process.env.SMTP_PASSWORD)) {
    throw new Error("SMTP server settings are not set in environment variables! Please set " +
        "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD")
  }

  var connection = new SMTPConnection({
    port: process.env.SMTP_PORT,
    host: process.env.SMTP_HOST,
    secure: !!parseInt(process.env.SMTP_SECURE),
    debug: true,
    authMethod: "PLAIN"
  })
  connection.on("error", err => console.error(err))
  await BlueBird.promisify(connection.connect, {context: connection})()
  await BlueBird.promisify(connection.login, {context: connection})({
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  })
  var result = await BlueBird.promisify(connection.send, {context: connection})(envelope, message)

  connection.quit()
  return result
}

// Nodemailer support
var transporter = nodemailer.createTransport(`smtps://${encodeURIComponent(process.env.SMTP_USER)}:${encodeURIComponent(process.env.SMTP_PASSWORD)}@${process.env.SMTP_HOST}`)

export async function sendMail (options) {
  return transporter.sendMail(options)
}

/** Replaces part of a string with asterisks */
function hidePart (s) {
  if (s.length <= 4) {
    var r = s.substr(0, 1)
    while (r.length < s.length) {
      r += '*'
    }
    return r
  } else {
    var r1 = s.substr(0, 2)
    var r2 = s.substr(s.length - 2, 2)
    while (r1.length < s.length - r2.length) {
      r1 += '*'
    }
    r1 += r2
    return r1
  }
}

/** Replaces the username and domain name section of an
    email address with asterisks */
export function anonymizeEmail (email) {
  if (email === null) {
    return null
  } else {
    var re = /^(.*)@(.*)\.([^.]+)$/
    var matches = email.match(re)
    if (matches === null) {
      return null
    }

    var hiddenEmail = hidePart(matches[1]) +
      '@' +
      hidePart(matches[2]) +
      '.' +
      hidePart(matches[3])

    return hiddenEmail
  }
}
