import SMTPConnection from "smtp-connection"
import nodemailer from "nodemailer"
import BlueBird from "bluebird"

export const send = async function send(envelope, message) {
  if (
    !(
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASSWORD
    )
  ) {
    throw new Error(
      "SMTP server settings are not set in environment variables! Please set " +
        "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD"
    )
  }

  let connection = new SMTPConnection({
    port: process.env.SMTP_PORT,
    host: process.env.SMTP_HOST,
    secure: !!parseInt(process.env.SMTP_SECURE),
    debug: true,
    authMethod: "PLAIN",
  })
  connection.on("error", err => console.error(err))
  await BlueBird.promisify(connection.connect, { context: connection })()
  await BlueBird.promisify(connection.login, { context: connection })({
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  })
  let result = await BlueBird.promisify(connection.send, {
    context: connection,
  })(envelope, message)

  connection.quit()
  return result
}

// Nodemailer support
let transporter = nodemailer.createTransport(
  `smtps://${encodeURIComponent(process.env.SMTP_USER)}:${encodeURIComponent(
    process.env.SMTP_PASSWORD
  )}@${process.env.SMTP_HOST}`
)

export const sendMail = async function sendMail(options) {
  return transporter.sendMail(options)
}

/**
 * Replaces part of a string with asterisks
 * @param {string} s - the input string
 * @return {string} the string masked with asterisks.
 * only the first character is exposed if the input string length
 * is less than or equal to 4, otherwise, only the first two and
 * last two characters are exposed
 */
function hidePart(s) {
  if (s.length <= 4) {
    let r = s.substr(0, 1)
    while (r.length < s.length) {
      r += "*"
    }
    return r
  } else {
    let r1 = s.substr(0, 2)
    let r2 = s.substr(s.length - 2, 2)
    while (r1.length < s.length - r2.length) {
      r1 += "*"
    }
    r1 += r2
    return r1
  }
}

/**
 * Replaces the username and domain name section of an
 * email address with asterisks
 * @param {string} email - the email as a string
 * @return {string} the masked email
 */
export function anonymizeEmail(email) {
  if (email === null) {
    return null
  } else {
    let re = /^(.*)@(.*)\.([^.]+)$/
    let matches = email.match(re)
    if (matches === null) {
      return null
    }

    let hiddenEmail =
      hidePart(matches[1]) +
      "@" +
      hidePart(matches[2]) +
      "." +
      hidePart(matches[3])

    return hiddenEmail
  }
}
