import { promises as fs } from 'node:fs'
import { getenv } from '../lib/dotenv.mjs'
import { parseYaml } from '../lib/helper.mjs'
import { ZodConfig, type StrategyConfig } from './strategy/rateCalculator.js'

export type StrategyMode = 'off' | 'dry_run' | 'live'

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
  strategyMode: StrategyMode
  strategyConfig: StrategyConfig
  strategyConfigSource: string
  strategy: {
    debounceMs: number
    candleRefreshMs: number
    statusRefreshMs: number
    warmupMs: number
    minIntervalMs: number
    minRateChangePct: number
    dailyBudget: number
    minAmountToTrade: number
  }
}

function required (key: string): string {
  const v = getenv(key)
  if (v == null || v === '') throw new Error(`Missing required env: ${key}`)
  return v
}

function optional (key: string, fallback = ''): string {
  return getenv(key) ?? fallback
}

function parseMode (raw: string): StrategyMode {
  const v = raw.trim().toLowerCase()
  if (v === 'live') return 'live'
  if (v === 'dry_run' || v === 'dry-run' || v === 'dryrun') return 'dry_run'
  return 'off'
}

async function loadStrategyConfig (): Promise<{ config: StrategyConfig, source: string }> {
  const file = optional('STRATEGY_CONFIG_FILE', '')
  const inline = optional('STRATEGY_CONFIG_YAML', '') || optional('INPUT_AUTO_RENEW_3', '')

  let yamlStr = ''
  let source = '(empty)'
  if (file) {
    try {
      yamlStr = await fs.readFile(file, 'utf-8')
      source = `file:${file}`
    } catch (err: any) {
      throw new Error(`STRATEGY_CONFIG_FILE could not be read: ${err.message}`)
    }
  } else if (inline) {
    yamlStr = inline
    source = optional('STRATEGY_CONFIG_YAML') ? 'env:STRATEGY_CONFIG_YAML' : 'env:INPUT_AUTO_RENEW_3'
  }
  const parsed = ZodConfig.parse(yamlStr ? parseYaml(yamlStr) : {})
  return { config: parsed, source }
}

export async function loadConfig (): Promise<BotConfig> {
  const { config: strategyConfig, source: strategyConfigSource } = await loadStrategyConfig()
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
    strategyMode: parseMode(optional('STRATEGY_MODE', 'off')),
    strategyConfig,
    strategyConfigSource,
    strategy: {
      debounceMs: parseInt(optional('STRATEGY_DEBOUNCE_MS', '1500'), 10),
      candleRefreshMs: parseInt(optional('STRATEGY_CANDLE_REFRESH_MS', '60000'), 10),
      statusRefreshMs: parseInt(optional('STRATEGY_STATUS_REFRESH_MS', '300000'), 10),
      warmupMs: parseInt(optional('STRATEGY_WARMUP_MS', '60000'), 10),
      minIntervalMs: parseInt(optional('STRATEGY_MIN_INTERVAL_MS', '30000'), 10),
      minRateChangePct: parseFloat(optional('STRATEGY_MIN_RATE_CHANGE_PCT', '1')),
      dailyBudget: parseInt(optional('STRATEGY_DAILY_BUDGET', '200'), 10),
      minAmountToTrade: parseFloat(optional('STRATEGY_MIN_AMOUNT_TO_TRADE', '1')),
    },
  }
}
