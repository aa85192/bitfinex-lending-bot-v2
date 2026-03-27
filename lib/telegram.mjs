import _ from 'lodash'
import { getenv } from './dotenv.mjs'

const TELEGRAM_TOKEN = getenv('TELEGRAM_TOKEN')
const TELEGRAM_CHAT_ID = getenv('TELEGRAM_CHAT_ID')

async function telegramPost (path, body) {
  if (_.isNil(TELEGRAM_TOKEN)) throw new Error('TELEGRAM_TOKEN is not set')
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${path}`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const respJson = await resp.json().catch(() => null) // catch all error
    if (resp.ok !== true || respJson?.ok !== true) {
      const errMsg = _.isNil(respJson) ? `HTTP ${resp.status}: ${resp.statusText}` : `Telegram API ${respJson?.error_code}: ${respJson?.description}`
      throw _.merge(new Error(errMsg), { data: { respJson } })
    }
    return respJson.result
  } catch (err) {
    throw _.merge(err, { data: { method: 'POST', path, body } })
  }
}

export async function sendMessage (body) {
  // await telegram.sendMessage({ text: 'Hello world.' })
  return await telegramPost('sendMessage', { chat_id: TELEGRAM_CHAT_ID, ...body })
}

export async function editMessageText (body) {
  // await telegram.editMessageText({ message_id: 123, text: 'Updated text.' })
  return await telegramPost('editMessageText', { chat_id: TELEGRAM_CHAT_ID, ...body })
}

export function tgMdEscape (str) {
  return str.toString().replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

export function tgMdDate (opts) {
  const { text, date, format = 'r' } = opts
  const unix = Math.floor(new Date(date).getTime() / 1000)
  return `[${text}](tg://date?date=${unix}&format=${format})`
}
