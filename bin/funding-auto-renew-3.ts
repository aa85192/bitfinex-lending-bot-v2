/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 明確取得「最近 24 小時」的 1 分鐘 Funding Candles
2. 每根 K 線建立利率區間 [low, high]，以成交量 × 線性時間權重（30 分鐘 bucket）為量
3. 二分搜尋：在加權體積分佈中以 rank 百分位數找出目標利率
4. 夾住在 rateMin ~ rateMax 之間後，設定自動出借

時間權重：同一個 30 分鐘 bucket 內的蠟燭共享相同權重，線性從 1.0（最新）衰減至 0.5（24h 前）。
不使用 FRR：自我強化迴圈使 FRR 系統性偏高。
不使用 Funding Book：book 上只有未成交的掛單（利率太低沒人借的），不反映真實成交行情。
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import { floatFloor8, floatFormatDecimal, floatFormatPercent, floatIsEqual, parseYaml, progressPercent, rateStringify } from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:taichunmin_${filename}`
const RATE_MIN = 0.0001 // APR 3.65%
const WINDOW_MS = 24 * 60 * 60 * 1000
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000
const BUCKET_MS = 30 * 60 * 1000 // 時間 bucket 大小：30 分鐘
const WINDOW_BUCKETS = Math.ceil(WINDOW_MS / BUCKET_MS) // 48 buckets
const TIME_WEIGHT_MIN = 0.5 // 最舊 bucket（24h 前）的時間權重
const TIME_WEIGHT_MAX = 1.0 // 最新 bucket 的時間權重
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

// 線性時間權重：依 30 分鐘 bucket 分組，最新 = TIME_WEIGHT_MAX，最舊 = TIME_WEIGHT_MIN
function linearTimeWeight (mts: number, nowTs: number): number {
  const bucketIndex = Math.floor((nowTs - mts) / BUCKET_MS)
  const t = Math.min(bucketIndex / (WINDOW_BUCKETS - 1), 1)
  return TIME_WEIGHT_MAX - (TIME_WEIGHT_MAX - TIME_WEIGHT_MIN) * t
}

interface RangeEntry { low: number, high: number, vol: number }

// 把蠟燭轉成 [low, high, vol] 區間，合併相同區間，以成交量 × 時間權重為量
function buildRanges (
  candles: Array<{ mts: Date, open: number, close: number, high: number, low: number, volume: number }>,
  nowTs: number,
  applyTimeWeight: boolean,
): RangeEntry[] {
  const rangeMap = new Map<string, number>()
  for (const c of candles) {
    if (c.volume <= 0) continue
    const low = _.round(_.min([c.open, c.close, c.high, c.low])!, 8)
    const high = _.round(_.max([c.open, c.close, c.high, c.low])!, 8)
    if (high <= 0 || low <= 0) continue
    const tw = applyTimeWeight ? linearTimeWeight(+c.mts, nowTs) : 1.0
    const key = `${low}|${high}`
    rangeMap.set(key, (rangeMap.get(key) ?? 0) + c.volume * tw)
  }
  return [...rangeMap.entries()]
    .map(([key, vol]) => { const [low, high] = key.split('|').map(Number); return { low, high, vol } })
    .filter(r => r.vol > 0)
    .sort((a, b) => a.low !== b.low ? a.low - b.low : a.high - b.high)
}

// 二分搜尋：找出累積加權體積 = totalVol * rank 的利率
function binarySearchRate (ranges: RangeEntry[], totalVol: number, rank: number): number {
  if (ranges.length === 0 || totalVol <= 0) return 0
  const targetVol = totalVol * rank
  let lo = ranges[0].low
  let hi = ranges[ranges.length - 1].high
  let bestRate = lo
  let bestDiff = Infinity
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2
    if (mid === lo || mid === hi) break
    let midVol = 0
    for (const { low, high, vol } of ranges) {
      if (mid < low) break
      midVol += mid >= high ? vol : vol * (mid - low) / (high - low)
    }
    const diff = Math.abs(midVol - targetVol)
    if (diff < bestDiff) { bestDiff = diff; bestRate = mid }
    if (midVol === targetVol) break
    if (targetVol < midVol) hi = mid
    else lo = mid
  }
  return bestRate
}

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

class SkipError extends Error {}

export async function main (): Promise<void> {
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  ymlDump('runtime', {
    script: import.meta.url,
    githubSha: process.env.GITHUB_SHA ?? null,
    node: process.version,
  })

  const cfg = ZodConfig.parse(parseYaml(getenv('INPUT_AUTO_RENEW_3', '')))

  const db = ZodDb.parse((await bitfinex.v2AuthReadSettings([DB_KEY]).catch(() => ({})))[DB_KEY.slice(4)])
  ymlDump('db', db)

  const wallets = _.mapKeys(await bitfinex.v2AuthReadWallets(), ({ type, currency }) => `${type}:${currency}`)
  ymlDump('wallets', wallets)

  for (const [currency, cfg1] of _.entries(cfg)) {
    const trace: Record<string, any> = { currency, cfg1 }
    try {
      ymlDump(`cfg.${currency}`, {
        currency,
        ...cfg1,
        rateMinStr: rateStringify(cfg1.rateMin),
        rateMaxStr: rateStringify(cfg1.rateMax),
      })

      try {
        const prevAutoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency })
        if (_.isNil(prevAutoRenew)) ymlDump('prevAutoRenew', { status: false })
        else {
          ymlDump('prevAutoRenew', {
            ...prevAutoRenew,
            rateStr: rateStringify(prevAutoRenew.rate),
          })
        }

        // 明確鎖定最近 24 小時視窗，避免 `limit: 1440` 跨越超過 24h
        const now = Date.now()
        const windowStart = new Date(now - WINDOW_MS)
        const windowEnd = new Date(now)

        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 10000,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          start: windowStart,
          end: windowEnd,
          timeframe: '1m',
        })

        const validCandles = candles.filter(c => c.volume > 0 && c.high > 0)
        const weightedRanges = buildRanges(validCandles, now, true)
        const rawRanges = buildRanges(validCandles, now, false)
        const totalWeightedVol = _.sumBy(weightedRanges, 'vol')
        const totalRawVol = _.sumBy(rawRanges, 'vol')

        const newestCandleTs = validCandles[0] != null ? +validCandles[0].mts : null
        const oldestCandleTs = validCandles.at(-1) != null ? +validCandles.at(-1)!.mts : null
        const actualSpanHours = newestCandleTs != null && oldestCandleTs != null
          ? _.round((newestCandleTs - oldestCandleTs) / 3_600_000, 2)
          : null

        ymlDump('candleMetrics', {
          requestedWindowStart: dayjs(windowStart).utcOffset(8).format('M/D HH:mm:ss'),
          requestedWindowEnd: dayjs(windowEnd).utcOffset(8).format('M/D HH:mm:ss'),
          rawCount: candles.length,
          validEntries: validCandles.length,
          firstValidCandle: newestCandleTs != null ? dayjs(newestCandleTs).utcOffset(8).format('M/D HH:mm:ss') : null,
          lastValidCandle: oldestCandleTs != null ? dayjs(oldestCandleTs).utcOffset(8).format('M/D HH:mm:ss') : null,
          actualSpanHours,
          missingMinutesApprox: _.max([0, 1440 - validCandles.length]),
          lowestRate: weightedRanges[0] != null ? rateStringify(weightedRanges[0].low) : null,
          highestRate: weightedRanges.at(-1) != null ? rateStringify(weightedRanges.at(-1)!.high) : null,
          timeWeightRange: `${TIME_WEIGHT_MIN} ~ ${TIME_WEIGHT_MAX} (linear, ${BUCKET_MS / 60000}min buckets)`,
        })

        if (weightedRanges.length === 0 || totalWeightedVol <= 0) {
          throw new SkipError(`[${currency}] No valid candle data in the last 24 hours.`)
        }

        const effectiveRank = cfg1.rank
        const targetRate = binarySearchRate(weightedRanges, totalWeightedVol, effectiveRank)

        // === 診斷 log ===

        // 1. 百分位數分布（有時間權重），用 binarySearchRate 找出各百分位利率
        const percentiles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]
        const pctMap: Record<string, string> = {}
        for (const p of percentiles) {
          pctMap[`p${_.round(p * 100)}`] = rateStringify(binarySearchRate(weightedRanges, totalWeightedVol, p))
        }
        ymlDump('distribution', pctMap)

        // 2. 利率閾值分析（APR 7.3% 以下視為 FRR 區間）
        const frrThreshold = 0.0002
        let volBelowThreshold = 0
        for (const { low, high, vol } of weightedRanges) {
          if (frrThreshold < low) break
          volBelowThreshold += frrThreshold >= high ? vol : vol * (frrThreshold - low) / (high - low)
        }
        ymlDump('thresholdAnalysis', {
          frrThreshold: rateStringify(frrThreshold),
          belowRangeCount: weightedRanges.filter(r => r.low < frrThreshold).length,
          aboveRangeCount: weightedRanges.filter(r => r.low >= frrThreshold).length,
          belowVolPct: floatFormatPercent(volBelowThreshold / totalWeightedVol),
          aboveVolPct: floatFormatPercent((totalWeightedVol - volBelowThreshold) / totalWeightedVol),
          configRank: cfg1.rank,
          effectiveRank,
        })

        // 3. 無衰減分布對比（等權重 = 每根 K 線 weight 1）
        const rawPctMap: Record<string, string> = {}
        for (const p of percentiles) {
          rawPctMap[`p${_.round(p * 100)}`] = rateStringify(binarySearchRate(rawRanges, totalRawVol, p))
        }
        ymlDump('distributionNoDecay', rawPctMap)

        // 4. 最近 2 小時 vs 之前 22 小時（都限定在最近 24 小時視窗內）
        const recentCutoff = now - RECENT_WINDOW_MS
        const recentCandles = validCandles.filter(c => +c.mts >= recentCutoff)
        const olderCandles = validCandles.filter(c => +c.mts < recentCutoff)
        const avgHigh = (list: Array<{ high: number }>): number =>
          list.length > 0 ? _.meanBy(list, 'high') : 0
        ymlDump('recentVsOlder', {
          recent2h: {
            count: recentCandles.length,
            avgHigh: rateStringify(avgHigh(recentCandles)),
            totalVol: floatFormatDecimal(_.sumBy(recentCandles, 'volume'), 2),
          },
          older22h: {
            count: olderCandles.length,
            avgHigh: rateStringify(avgHigh(olderCandles)),
            totalVol: floatFormatDecimal(_.sumBy(olderCandles, 'volume'), 2),
          },
        })

        // 5. High vs Close 差距分析
        const highCloseGaps = validCandles
          .map(c => ({ gapPct: (c.high - c.close) / c.high, volume: c.volume }))
        const significantGaps = highCloseGaps.filter(g => g.gapPct > 0.3)
        ymlDump('highCloseAnalysis', {
          totalCandles: highCloseGaps.length,
          avgGapPct: floatFormatPercent(_.meanBy(highCloseGaps, 'gapPct')),
          medianGapPct: floatFormatPercent(_.sortBy(highCloseGaps, 'gapPct')[Math.floor(highCloseGaps.length / 2)]?.gapPct ?? 0),
          significantGapCount: significantGaps.length,
          significantGapAvgVol: floatFormatDecimal(_.meanBy(significantGaps, 'volume') ?? 0, 2),
          normalGapAvgVol: floatFormatDecimal(_.meanBy(highCloseGaps.filter(g => g.gapPct <= 0.3), 'volume') ?? 0, 2),
        })

        // 6. 每小時 high 均值趨勢（只看最近 24 小時有效 candles）
        const hourlyBuckets: Record<number, { sumRate: number, count: number }> = {}
        for (const c of validCandles) {
          const hour = new Date(+c.mts).getUTCHours()
          if (!hourlyBuckets[hour]) hourlyBuckets[hour] = { sumRate: 0, count: 0 }
          hourlyBuckets[hour].sumRate += c.high
          hourlyBuckets[hour].count++
        }
        const hourlyRates: Record<string, string> = {}
        for (const h of _.sortBy(_.keys(hourlyBuckets).map(Number))) {
          const b = hourlyBuckets[h]
          hourlyRates[`${String(h).padStart(2, '0')}:00`] = `${rateStringify(b.count > 0 ? b.sumRate / b.count : 0)} cnt=${b.count}`
        }
        ymlDump('hourlyRates', hourlyRates)

        ymlDump('pricing', {
          method: 'candle_range_volume_linear_decay',
          rank: cfg1.rank,
          effectiveRank,
          targetRate,
          targetRateStr: rateStringify(targetRate),
        })

        const newAutoRenew = trace.newAutoRenew = {
          amount: cfg1.amount,
          currency,
          period: rateToPeriod(cfg1.period, _.clamp(targetRate, cfg1.rateMin, cfg1.rateMax)),
          rate: _.clamp(targetRate, cfg1.rateMin, cfg1.rateMax),
        }
        ymlDump('newAutoRenew', { ...newAutoRenew, rateStr: rateStringify(newAutoRenew.rate) })

        if (_.isMatch(prevAutoRenew ?? {}, newAutoRenew)) {
          trace.autoRenewChanged = false
          loggers.log('Setting of auto-renew no change.')
        } else {
          trace.autoRenewChanged = true
          if (!_.isNil(prevAutoRenew)) await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
          await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency })
          await bitfinex.v2AuthWriteFundingAuto({
            ...newAutoRenew,
            rate: floatFloor8(newAutoRenew.rate * 100), // API 要的是百分比
            status: 1,
          }).catch(err => { throw _.set(err, 'data.newAutoRenew', newAutoRenew) })
          await scheduler.wait(1000)
        }
      } catch (err) {
        if (!(err instanceof SkipError)) throw err
        loggers.log(err.message)
      }

      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      if (wallet.balance >= Number.EPSILON && !_.isNil(trace.newAutoRenew)) {
        const db1: Record<string, any> = db.notified?.[currency] ?? {}
        const autoRenew = _.pickBy(trace.newAutoRenew, _.isNumber)

        const [creditsRaw, orders] = await Promise.all([
          bitfinex.v2AuthReadFundingCredits({ currency }),
          bitfinex.v2AuthReadFundingOffers({ currency }),
        ])
        const credits = _.chain(creditsRaw)
          .filter(({ side }) => side === 1)
          .map(credit => _.pick(credit, ['id', 'amount', 'rate', 'period', 'mtsOpening']))
          .map(credit => ({
            ...credit,
            mtsOpening: dayjs(credit.mtsOpening).utcOffset(8).format('M/D HH:mm'),
            rate: floatFormatPercent(credit.rate, 6),
            apr: floatFormatPercent(credit.rate * 365),
          }))
          .value()
        const creditsAmountSum = _.sumBy(credits, 'amount')
        const creditIds = _.sortBy(_.map(credits, 'id'))
        const ordersAmountSum = _.sumBy(orders, 'amount')

        const nowts = dayjs().utcOffset(8)
        const msgText = [
          telegram.tgMdEscape(`# ${filename}: ${currency} 狀態

投資額: ${floatFormatDecimal(wallet.balance, 3)}
已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, wallet.balance)})
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, wallet.balance)})
自動掛單設定:
    利率: ${floatFormatPercent(autoRenew.rate, 6)}
    APR: ${floatFormatPercent(autoRenew.rate * 365)}
    天數: ${autoRenew.period}`),
          `更新: ${telegram.tgMdEscape(nowts.format('M/D HH:mm'))}\n`,
          '**>```',
          ymlStringify({ credits }),
          '```||',
        ].join('\n')

        const sendAndSave = async () => {
          const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
          _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: wallet.balance, creditIds })
        }
        const reuseMsgId = _.isNumber(db1.msgId)
          && floatIsEqual(db1.balance, wallet.balance)
          && _.isEqual(db1.creditIds, creditIds)
        if (reuseMsgId) {
          try {
            await telegram.editMessageText({ message_id: db1.msgId, parse_mode: 'MarkdownV2', text: msgText })
          } catch {
            await sendAndSave()
          }
        } else {
          if (_.isNumber(db1.msgId)) await telegram.deleteMessage({ message_id: db1.msgId }).catch(() => {})
          await sendAndSave()
        }
      }
    } catch (err) {
      _.update(err, `data.main.${currency}`, old => old ?? trace)
      loggers.error([err])
    } finally {
      loggers.log('- - -\n')
    }
  }

  ymlDump('newDb', db)
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any }).catch(loggers.error)
}

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
