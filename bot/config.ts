import { getenv } from '../lib/dotenv.mjs'

export interface BotConfig {
  bitfinexApiKey: string
  bitfinexApiSecret: string
  bitfinexAffCode?: string
  currencies: string[]
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject: string
  apiPort: number
  dataDir: string
  viewerToken: string
  publicOrigin: string
  rateAlertThreshold: number
  largeTradeMinAmount: number
}

function required (key: string): string {
  const v = getenv(key)
  if (v == null || v === '') throw new Error(`Missing required env: ${key}`)
  return v
}

function optional (key: string, fallback = ''): string {
  return getenv(key) ?? fallback
}

export function loadConfig (): BotConfig {
  return {
    bitfinexApiKey: required('BITFINEX_API_KEY'),
    bitfinexApiSecret: required('BITFINEX_API_SECRET'),
    bitfinexAffCode: optional('BITFINEX_AFF_CODE') || undefined,
    currencies: optional('BOT_CURRENCIES', 'USD,UST')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    vapidPublicKey: required('VAPID_PUBLIC_KEY'),
    vapidPrivateKey: required('VAPID_PRIVATE_KEY'),
    vapidSubject: optional('VAPID_SUBJECT', 'mailto:bot@localhost'),
    apiPort: parseInt(optional('BOT_API_PORT', '8080'), 10),
    dataDir: optional('BOT_DATA_DIR', './data'),
    viewerToken: optional('VIEWER_TOKEN', ''),
    publicOrigin: optional('PUBLIC_ORIGIN', '*'),
    rateAlertThreshold: parseFloat(optional('RATE_ALERT_THRESHOLD', '0.0006')),
    largeTradeMinAmount: parseFloat(optional('LARGE_TRADE_MIN_AMOUNT', '50000')),
  }
}
