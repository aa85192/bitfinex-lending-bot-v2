/*
yarn tsx ./bin/funding-auto-renew-4.ts

長駐 daemon 版本（v4）：
- 在 Google VM 上持續執行，不依賴 GitHub Actions cron
- 每 TICK_MS（預設 60 秒）執行一次利率計算
- 本地快取 24h K 線：啟動時全量抓取，每 tick 增量補最新幾根，每小時全量刷新
- 每個幣種有寫入冷卻（WRITE_COOLDOWN_MS），防止在利率震盪時頻繁觸發寫 API
- 利率變動低於 RATE_CHANGE_MIN_BI 時跳過寫入
- Telegram 通知節流：credits 未變動時最多每 5 分鐘 edit 一次
- SIGTERM / SIGINT 優雅關閉，退出前儲存 DB

設定方式：在 .env 裡加入 INPUT_AUTO_RENEW_4，格式與 v3 的 INPUT_AUTO_RENEW_3 相同
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import {
  floatFloor8, floatFormatDecimal, floatFormatPercent,
  floatIsEqual, parseYaml, progressPercent, rateStringify,
} from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:wtkuo_${filename}`

// ── 計算常數（同 v3）──
const RATE_MIN = 0.0001
const WINDOW_MS = 24 * 60 * 60 * 1000
const BUCKET_MS = 30 * 60 * 1000
const WINDOW_BUCKETS = Math.ceil(WINDOW_MS / BUCKET_MS)
const WEIGHT_SCALE = 1_000_000n
const RATE_SCALE = 100_000_000n
const TIME_WEIGHT_MIN_BI = 850_000n
const TIME_WEIGHT_MAX_BI = 1_000_000n

// ── Daemon 控制常數 ──
const TICK_MS = 60_000                      // 主迴圈間隔：60 秒
const WRITE_COOLDOWN_MS = 3 * 60_000       // 同一幣種連續寫入最短間隔
const CANDLE_FULL_REFRESH_MS = 60 * 60_000 // 每 60 分鐘全量重抓 K 線（防快取漂移）
const CANDLE_INCR_LIMIT = 5                // 增量更新：每次只抓最新 N 根
const RATE_CHANGE_MIN_BI = 1000n           // 利率變動低於此值（≈ 0.365% APR/day）不寫 API
const TELEGRAM_THROTTLE_MS = 5 * 60_000   // credits 未變動時 Telegram edit 節流

;(BigInt as any).prototype.toJSON ??= function () { return this.toString() }

const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

// ── BigInt 計算（同 v3，邏輯完全一致）──

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

function linearTimeWeightBI (mts: number, nowTs: number): bigint {
  const bucketIndex = Math.min(
    Math.max(Math.floor((nowTs - mts) / BUCKET_MS), 0),
    WINDOW_BUCKETS - 1,
  )
  const decay = (TIME_WEIGHT_MAX_BI - TIME_WEIGHT_MIN_BI) * BigInt(bucketIndex) / BigInt(WINDOW_BUCKETS - 1)
  return TIME_WEIGHT_MAX_BI - decay
}

interface RangeEntryBI { low: bigint, high: bigint, vol: bigint }
interface CandleEntry { mts: Date, open: number, close: number, high: number, low: number, volume: number }

function buildRangesBI (
  candles: CandleEntry[],
  nowTs: number,
  applyTimeWeight: boolean,
): RangeEntryBI[] {
  const rangeMap = new Map<string, bigint>()
  for (const c of candles) {
    if (c.volume <= 0) continue
    const lowN = _.min([c.open, c.close, c.high, c.low])!
    const highN = _.max([c.open, c.close, c.high, c.low])!
    if (highN <= 0 || lowN <= 0) continue
    const low = BigInt(_.round(lowN * 1e8))
    const high = BigInt(_.round(highN * 1e8))
    const volBI = BigInt(_.round(c.volume * 1e8))
    const tw = applyTimeWeight ? linearTimeWeightBI(+c.mts, nowTs) : WEIGHT_SCALE
    const weightedVol = volBI * tw / WEIGHT_SCALE
    if (weightedVol <= 0n) continue
    const key = `${low}|${high}`
    rangeMap.set(key, (rangeMap.get(key) ?? 0n) + weightedVol)
  }
  return [...rangeMap.entries()]
    .map(([key, vol]) => {
      const [lowStr, highStr] = key.split('|')
      return { low: BigInt(lowStr), high: BigInt(highStr), vol }
    })
    .filter(r => r.vol > 0n)
    .sort((a, b) =>
      a.low !== b.low
        ? (a.low < b.low ? -1 : 1)
        : (a.high < b.high ? -1 : a.high > b.high ? 1 : 0))
}

function binarySearchRateBI (
  ranges: RangeEntryBI[],
  totalVol: bigint,
  rank: bigint,
): bigint {
  if (ranges.length === 0 || totalVol <= 0n) return 0n
  let lo = ranges[0].low
  let hi = ranges[0].high
  for (const r of ranges) {
    if (r.low < lo) lo = r.low
    if (r.high > hi) hi = r.high
  }
  let bestRate = lo
  let bestDiff: bigint | null = null
  while (lo <= hi) {
    const mid = (lo + hi) / 2n
    let midVol = 0n
    for (const { low, high, vol } of ranges) {
      if (mid < low) break
      midVol += mid >= high
        ? vol
        : vol * (mid - low + 1n) / (high - low + 1n)
    }
    const midRank = midVol * RATE_SCALE / totalVol
    const diff = bigintAbs(midRank - rank)
    if (bestDiff === null || diff < bestDiff) {
      bestDiff = diff
      bestRate = mid
    }
    if (midRank === rank) break
    if (rank < midRank) hi = mid - 1n
    else lo = mid + 1n
  }
  return bestRate
}

// ── Config / DB Schema（同 v3）──

const ZodConfigPeriod = z.record(
  z.coerce.number().int().min(2).max(120),
  z.number().positive(),
).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.8),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
})

const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

const ZodDb = z.object({
  schema: z.literal(1),
  notified: z.record(
    z.string(),
    z.object({
      balance: z.number().transform(floatFloor8),
      creditIds: z.array(z.number().int()),
      msgId: z.number().int(),
    }).nullish().catch(null),
  ).nullish().catch(null),
}).catch({ schema: 1 })

export function rateToPeriod (periodMap: z.output<typeof ZodConfigPeriod>, rateTarget: number): number {
  const ctxPeriod: Record<string, number | null> = { lower: null, target: null, upper: null }
  for (const entry of _.entries(periodMap)) {
    const [period, rate] = [_.toSafeInteger(entry[0]), _.toFinite(entry[1])]
    if (rateTarget >= rate) ctxPeriod.lower = _.max([ctxPeriod.lower ?? period, period])
    if (rateTarget <= rate) ctxPeriod.upper = _.min([ctxPeriod.upper ?? period, period])
  }
  if (_.isNil(ctxPeriod.lower)) ctxPeriod.target = 2
  else if (_.isNil(ctxPeriod.upper)) ctxPeriod.target = ctxPeriod.lower
  else if (ctxPeriod.lower === ctxPeriod.upper) ctxPeriod.target = ctxPeriod.lower
  else ctxPeriod.target = Math.trunc(ctxPeriod.lower + (ctxPeriod.upper - ctxPeriod.lower) * (rateTarget - periodMap[ctxPeriod.lower]) / (periodMap[ctxPeriod.upper] - periodMap[ctxPeriod.lower]))
  return _.clamp(ctxPeriod.target, 2, 120)
}

// ── K 線快取 ──

interface CandleCache {
  map: Map<number, CandleEntry> // mts timestamp (ms) → candle
  lastFullRefresh: number
}

async function fetchCandlesFull (currency: string): Promise<CandleEntry[]> {
  const now = Date.now()
  return Bitfinex.v2CandlesHist({
    aggregation: 30, currency, limit: 10000,
    periodEnd: 30, periodStart: 2,
    sort: BitfinexSort.DESC,
    start: new Date(now - WINDOW_MS),
    end: new Date(now),
    timeframe: '1m',
  })
}

async function fetchCandlesIncr (currency: string): Promise<CandleEntry[]> {
  return Bitfinex.v2CandlesHist({
    aggregation: 30, currency, limit: CANDLE_INCR_LIMIT,
    periodEnd: 30, periodStart: 2,
    sort: BitfinexSort.DESC,
    timeframe: '1m',
  })
}

function mergeCandlesIntoCache (cache: CandleCache, newCandles: CandleEntry[], now: number): void {
  for (const c of newCandles) cache.map.set(+c.mts, c)
  const cutoff = now - WINDOW_MS
  for (const key of cache.map.keys()) { if (key < cutoff) cache.map.delete(key) }
}

function getCachedCandles (cache: CandleCache): CandleEntry[] {
  return _.sortBy([...cache.map.values()], c => -c.mts.getTime())
}

// ── 每幣種狀態 ──

interface CurrencyState {
  lastRateBI: bigint
  lastWriteAt: number
  lastTelegramEditAt: number
}

// ── 處理單一幣種 ──

async function processCurrency (
  currency: string,
  cfg1: z.output<typeof ZodConfigCurrency>,
  cache: CandleCache,
  state: CurrencyState,
  db: z.output<typeof ZodDb>,
  wallets: Record<string, any>,
): Promise<{ dbChanged: boolean }> {
  const now = Date.now()
  let dbChanged = false

  // ── K 線刷新 ──
  const needFullRefresh = (now - cache.lastFullRefresh) >= CANDLE_FULL_REFRESH_MS
  try {
    if (needFullRefresh || cache.map.size === 0) {
      const candles = await fetchCandlesFull(currency)
      cache.map.clear()
      mergeCandlesIntoCache(cache, candles, now)
      cache.lastFullRefresh = now
      loggers.log(`[${currency}] K線全量刷新 ${cache.map.size} 根`)
    } else {
      const recent = await fetchCandlesIncr(currency)
      mergeCandlesIntoCache(cache, recent, now)
    }
  } catch (err) {
    loggers.error(`[${currency}] K線更新失敗: ${(err as Error).message}`)
    if (cache.map.size === 0) return { dbChanged }
  }

  // ── 計算目標利率 ──
  const validCandles = getCachedCandles(cache).filter(c => c.volume > 0 && c.high > 0)
  const weightedRanges = buildRangesBI(validCandles, now, true)
  const totalWeightedVol = weightedRanges.reduce((s, r) => s + r.vol, 0n)

  if (weightedRanges.length === 0 || totalWeightedVol <= 0n) {
    loggers.log(`[${currency}] 無有效 K 線，跳過`)
    return { dbChanged }
  }

  const rankBI = BigInt(_.round(cfg1.rank * 1e8))
  const targetRateBI = binarySearchRateBI(weightedRanges, totalWeightedVol, rankBI)
  const clampedRate = _.clamp(Number(targetRateBI) / 1e8, cfg1.rateMin, cfg1.rateMax)
  const clampedRateBI = BigInt(_.round(clampedRate * 1e8))

  // ── 決定是否寫 API ──
  const prevAutoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency })
  const newAutoRenew = {
    amount: cfg1.amount,
    currency,
    period: rateToPeriod(cfg1.period, clampedRate),
    rate: clampedRate,
  }

  const rateChanged = bigintAbs(clampedRateBI - state.lastRateBI) >= RATE_CHANGE_MIN_BI
  const cooldownElapsed = (now - state.lastWriteAt) >= WRITE_COOLDOWN_MS
  const settingChanged = !_.isMatch(prevAutoRenew ?? {}, newAutoRenew)

  if (rateChanged && cooldownElapsed && settingChanged) {
    loggers.log(`[${currency}] 利率更新 ${rateStringify(Number(state.lastRateBI) / 1e8)} → ${rateStringify(clampedRate)}`)
    try {
      if (!_.isNil(prevAutoRenew)) await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
      await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency })
      await bitfinex.v2AuthWriteFundingAuto({
        ...newAutoRenew,
        rate: floatFloor8(newAutoRenew.rate * 100),
        status: 1,
      })
      await scheduler.wait(1000)
      state.lastRateBI = clampedRateBI
      state.lastWriteAt = now
    } catch (err) {
      loggers.error(`[${currency}] 更新 auto-renew 失敗: ${(err as Error).message}`)
    }
  } else {
    const reason = !rateChanged ? '無變動' : !cooldownElapsed ? '冷卻中' : '設定已同步'
    loggers.log(`[${currency}] ${rateStringify(clampedRate)} (${reason})`)
    // 即使不寫，也同步 lastRateBI 防止冷卻解除後用舊值比較
    if (!rateChanged) state.lastRateBI = clampedRateBI
  }

  // ── Telegram 狀態通知 ──
  const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
  if (wallet.balance < Number.EPSILON) return { dbChanged }

  const db1: Record<string, any> = db.notified?.[currency] ?? {}
  const autoRenew = _.pickBy(newAutoRenew, _.isNumber)

  const creditsRaw = await bitfinex.v2AuthReadFundingCredits({ currency })
  const orders = await bitfinex.v2AuthReadFundingOffers({ currency })

  const creditsForCalc = _.chain(creditsRaw)
    .filter(({ side }) => side === 1)
    .map(credit => _.pick(credit, ['id', 'amount', 'rate', 'period', 'mtsOpening']))
    .value()
  const creditsAmountSum = _.sumBy(creditsForCalc, 'amount')
  const creditIds = _.sortBy(_.map(creditsForCalc, 'id'))
  const ordersAmountSum = _.sumBy(orders, 'amount')
  const totalAmount = wallet.balance + creditsAmountSum + ordersAmountSum
  const weightedRateSum = _.sumBy(creditsForCalc, c => c.rate * c.amount)
  const portfolioApr = totalAmount > 0 ? weightedRateSum * 365 / totalAmount : 0
  const borrowedApr = creditsAmountSum > 0 ? weightedRateSum * 365 / creditsAmountSum : 0
  const credits = _.map(creditsForCalc, credit => ({
    ...credit,
    mtsOpening: dayjs(credit.mtsOpening).utcOffset(8).format('M/D HH:mm'),
    rate: floatFormatPercent(credit.rate, 6),
    apr: floatFormatPercent(credit.rate * 365),
  }))

  const nowts = dayjs().utcOffset(8)
  const msgText = [
    telegram.tgMdEscape(`# ${filename}: ${currency} 狀態

投資額: ${floatFormatDecimal(totalAmount, 3)}
已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, totalAmount)})
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, totalAmount)})
自動掛單設定:
    利率: ${floatFormatPercent(autoRenew.rate, 6)}
    APR: ${floatFormatPercent(autoRenew.rate * 365)}
    天數: ${autoRenew.period}
收益率:
    借出APR: ${floatFormatPercent(borrowedApr)}
    綜合APR: ${floatFormatPercent(portfolioApr)}`),
    `更新: ${telegram.tgMdEscape(nowts.format('M/D HH:mm'))}\n`,
    '**>```',
    ymlStringify({ credits }),
    '```||',
  ].join('\n')

  const creditsChanged = !floatIsEqual(db1.balance ?? -1, totalAmount) || !_.isEqual(db1.creditIds, creditIds)
  const throttleElapsed = (now - state.lastTelegramEditAt) >= TELEGRAM_THROTTLE_MS

  if (!_.isNumber(db1.msgId)) {
    // 從未發過訊息
    const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
    _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: totalAmount, creditIds })
    state.lastTelegramEditAt = now
    dbChanged = true
  } else if (creditsChanged) {
    // credits 或金額變動 → 刪舊發新
    await telegram.deleteMessage({ message_id: db1.msgId }).catch(() => {})
    const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
    _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: totalAmount, creditIds })
    state.lastTelegramEditAt = now
    dbChanged = true
  } else if (throttleElapsed) {
    // 只更新時間戳，節流後才 edit
    try {
      await telegram.editMessageText({ message_id: db1.msgId, parse_mode: 'MarkdownV2', text: msgText })
    } catch {
      const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
      _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: totalAmount, creditIds })
      dbChanged = true
    }
    state.lastTelegramEditAt = now
  }

  return { dbChanged }
}

// ── 主迴圈 ──

export async function main (): Promise<void> {
  loggers.log(`${filename} daemon 啟動`)

  const cfg = ZodConfig.parse(parseYaml(getenv('INPUT_AUTO_RENEW_4', '')))
  if (_.isEmpty(cfg)) {
    loggers.error('INPUT_AUTO_RENEW_4 未設定或為空，請在 .env 中設定後重啟')
    process.exit(1)
  }

  const db = ZodDb.parse((await bitfinex.v2AuthReadSettings([DB_KEY]).catch(() => ({})))[DB_KEY.slice(4)])

  const candleCaches = new Map<string, CandleCache>()
  const currencyStates = new Map<string, CurrencyState>()
  for (const currency of _.keys(cfg)) {
    candleCaches.set(currency, { map: new Map(), lastFullRefresh: 0 })
    currencyStates.set(currency, { lastRateBI: 0n, lastWriteAt: 0, lastTelegramEditAt: 0 })
  }

  let running = true
  let dbDirty = false

  const saveDb = async () => {
    if (!dbDirty) return
    try {
      await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any })
      dbDirty = false
    } catch (err) {
      loggers.error(`DB 儲存失敗: ${(err as Error).message}`)
    }
  }

  const shutdown = async (signal: string) => {
    loggers.log(`收到 ${signal}，儲存 DB 並關閉...`)
    running = false
    await saveDb()
    process.exit(0)
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })

  const tick = async () => {
    const platformStatus = await Bitfinex.v2PlatformStatus().catch(() => null)
    if (platformStatus?.status === PlatformStatus.MAINTENANCE) {
      loggers.log('Bitfinex 維護中，跳過此次 tick')
      return
    }

    const wallets = _.mapKeys(
      await bitfinex.v2AuthReadWallets(),
      ({ type, currency }) => `${type}:${currency}`,
    )

    for (const [currency, cfg1] of _.entries(cfg)) {
      try {
        const { dbChanged } = await processCurrency(
          currency, cfg1,
          candleCaches.get(currency)!,
          currencyStates.get(currency)!,
          db, wallets,
        )
        if (dbChanged) dbDirty = true
      } catch (err) {
        loggers.error(`[${currency}] tick 錯誤: ${(err as Error).message}`)
      }
    }

    await saveDb()
  }

  // 第一次立即執行
  await tick()

  // 主迴圈：等待 TICK_MS 後再執行下一次
  while (running) {
    await scheduler.wait(TICK_MS)
    if (!running) break
    try {
      await tick()
    } catch (err) {
      loggers.error(`tick 頂層錯誤: ${(err as Error).message}`)
    }
  }
}

class NotMainModuleError extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMainModuleError()
  const modulePath = url.fileURLToPath(import.meta.url)
  if (process.argv[1] !== modulePath) throw new NotMainModuleError()
  await main()
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error([err])
    process.exit(1)
  }
}
