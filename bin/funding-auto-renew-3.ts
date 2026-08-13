/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 從 funding ticker 取得即時 FRR 與 24 小時最高成交利率（24hHigh），
   兩者皆與 Bitfinex 網頁顯示的數字一致
2. 在 FRR 與 24hHigh 兩點之間，用 rank 當作往 24hHigh 靠近的插值比例：
   targetRate = FRR + rank × (24hHigh − FRR)
   不設 FRR 下限，行情冷時掛得比 FRR 低才借得出去，避免資金閒置
3. 夾住在 rateMin ~ rateMax 之間後設定自動出借，天期：
   - 利率 ≥ FRR：固定 120 天，鎖住這個好價格
   - 利率 < FRR：用 period 對照表插值取短天期，過幾天就能重新定價

不使用 Funding Book：book 上只有未成交的掛單（利率太低沒人借的），不反映真實成交行情。
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { readFileSync } from 'node:fs'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { getFundingTicker, rest } from '../lib/bitfinex.mjs'
import { dayjs } from '../lib/dayjs.mjs'
import { floatFloor8, floatFormatDecimal, floatFormatPercent, floatIsEqual, parseYaml, progressPercent, rateStringify } from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:wtkuo_${filename}`
const RATE_MIN = 0.0001 // APR 3.65%
const RESERVE_MIN_LENDABLE = 50 // Bitfinex 自動借出最小金額（USD 或等值），低於此視為保留金額已全數保留
const WINDOW_MS = 24 * 60 * 60 * 1000
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000
const LENDING_PERIOD = 120 // 固定借出天數
const BUCKET_MS = 30 * 60 * 1000 // 時間 bucket 大小：30 分鐘
const WINDOW_BUCKETS = Math.ceil(WINDOW_MS / BUCKET_MS) // 48 buckets
const WEIGHT_SCALE = 1_000_000n       // 時間權重精度 1e-6
const RATE_SCALE = 100_000_000n       // 利率精度 1e-8
const TIME_WEIGHT_MIN_BI = 850_000n   // 些微衰減：0.85（24h 前的 bucket）
const TIME_WEIGHT_MAX_BI = 1_000_000n // 最新 bucket：1.0
// 供 diagnostic log 使用
const TIME_WEIGHT_MIN = Number(TIME_WEIGHT_MIN_BI) / 1e6
const TIME_WEIGHT_MAX = Number(TIME_WEIGHT_MAX_BI) / 1e6
// 既有掛單若比目前目標利率高出這個比例，視為行情已走掉的殭屍單，取消後讓它以新利率重掛
const STALE_OFFER_RATIO = 1.05
// 24h 最高成交利率直接取 funding ticker 的 HIGH，與 Bitfinex 網頁顯示的數字一致。
// K 線僅供診斷 log：天期區間對齊實際借出的 120 天，因為長短天期的行情差很多
// （實測同一時間 2~30 天中位數 7.27%、91~120 天中位數 11.11%），
// 用短天期行情判讀長天期的單會嚴重低估。
const CANDLE_PERIOD = { start: 91, end: 120 }
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

;(BigInt as any).prototype.toJSON ??= function () { return this.toString() }

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

// 線性時間權重（BigInt 版）：最新 bucket = TIME_WEIGHT_MAX_BI，24h 前 = TIME_WEIGHT_MIN_BI
function linearTimeWeightBI (mts: number, nowTs: number): bigint {
  const bucketIndex = Math.min(
    Math.max(Math.floor((nowTs - mts) / BUCKET_MS), 0),
    WINDOW_BUCKETS - 1,
  )
  const decay = (TIME_WEIGHT_MAX_BI - TIME_WEIGHT_MIN_BI) * BigInt(bucketIndex) / BigInt(WINDOW_BUCKETS - 1)
  return TIME_WEIGHT_MAX_BI - decay
}

interface RangeEntryBI { low: bigint, high: bigint, vol: bigint }

// 把蠟燭轉成 [low, high, vol] BigInt 區間，合併相同區間，成交量 × 時間權重
function buildRangesBI (
  candles: Array<{ mts: Date, open: number, close: number, high: number, low: number, volume: number }>,
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

// 二分搜尋（BigInt 版，含 +1n 端點修正）：找出累積加權體積 ≈ totalVol * rank 的利率
function binarySearchRateBI (
  ranges: RangeEntryBI[],
  totalVol: bigint,
  rank: bigint, // 單位 RATE_SCALE (1e8)，例如 rank=0.8 → 80_000_000n
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

// 利率低於 FRR 時，用這張「利率 → 天數」對照表插值決定天數（利率越低、天數越短）
const ZodConfigPeriod = z.record(
  z.coerce.number().int().min(2).max(120),
  z.number().positive(),
).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  reserveAmount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
})

const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

// 保留金額由 webapp（透過 GitHub Contents API）寫入 config/reserve-amount.json，
// 與 workflow 的 INPUT_AUTO_RENEW_3 分開存放，避免網頁需要能改動 .github/workflows/*.yml 的權限。
const ZodReserveAmountFile = z.record(z.string(), z.coerce.number().min(0)).catch({})

function readReserveAmountFile (): Record<string, number> {
  try {
    const raw = readFileSync(new URL('../config/reserve-amount.json', import.meta.url), 'utf8')
    return ZodReserveAmountFile.parse(JSON.parse(raw))
  } catch {
    return {}
  }
}

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

  const reserveAmountFile = readReserveAmountFile()
  ymlDump('reserveAmountFile', reserveAmountFile)
  for (const [currency, cfg1] of _.entries(cfg)) {
    if (currency in reserveAmountFile) cfg1.reserveAmount = reserveAmountFile[currency]
  }

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

        // 即時 FRR 改用 funding ticker（與 Bitfinex 網頁顯示一致）；funding stats hist 是歷史快照會落後
        const fundingTicker = await getFundingTicker({ currency })
        const frr = fundingTicker?.frr ?? 0
        // 24h 最高成交利率：直接用 ticker 的 HIGH，與 Bitfinex 網頁顯示的數字一致
        const high24h = fundingTicker?.high ?? 0
        ymlDump('fundingTicker', {
          currency,
          frr: rateStringify(frr),
          frrApr: floatFormatPercent(frr * 365),
          high24h: rateStringify(high24h),
          high24hApr: floatFormatPercent(high24h * 365),
          low24h: rateStringify(fundingTicker?.low ?? 0),
          last: rateStringify(fundingTicker?.last ?? 0),
          frrAmountAvailable: floatFormatDecimal(fundingTicker?.frrAmountAvailable ?? 0, 2),
        })

        if (!(high24h > 0)) {
          throw new SkipError(`[${currency}] funding ticker has no 24h high, skip.`)
        }

        // 明確鎖定最近 24 小時視窗，避免 `limit: 1440` 跨越超過 24h
        const now = Date.now()
        const windowStart = new Date(now - WINDOW_MS)
        const windowEnd = new Date(now)

        const fetchCandles = async (period: { start: number, end: number }) => {
          const list = await Bitfinex.v2CandlesHist({
            aggregation: 30,
            currency,
            limit: 10000,
            periodEnd: period.end,
            periodStart: period.start,
            sort: BitfinexSort.DESC,
            start: windowStart,
            end: windowEnd,
            timeframe: '1m',
          })
          return { list, valid: list.filter(c => c.volume > 0 && c.high > 0) }
        }

        const { list: candles, valid: validCandles } = await fetchCandles(CANDLE_PERIOD)

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
          candlePeriod: `p${CANDLE_PERIOD.start}~p${CANDLE_PERIOD.end}`,
          candleHigh24h: rateStringify(validCandles.length > 0 ? _.maxBy(validCandles, 'high')!.high : 0),
        })

        if (validCandles.length === 0) {
          throw new SkipError(`[${currency}] No valid candle data in the last 24 hours.`)
        }

        // 定價：FRR 與 24h 最高成交利率之間，以 rank 當作插值比例（rank 0.5 = 正中間）。
        // 兩個錨點都取自 funding ticker，與 Bitfinex 網頁顯示的數字一致。
        const targetRate = frr + cfg1.rank * (high24h - frr)

        // === 診斷 log ===
        // 以下百分位分布不參與定價，只用來對照「目標利率落在 120 天市場的哪個位置」
        const weightedRanges = buildRangesBI(validCandles, now, true)
        const rawRanges = buildRangesBI(validCandles, now, false)
        const totalWeightedVol = weightedRanges.reduce((s, r) => s + r.vol, 0n)
        const totalRawVol = rawRanges.reduce((s, r) => s + r.vol, 0n)

        if (weightedRanges.length === 0 || totalWeightedVol <= 0n) {
          throw new SkipError(`[${currency}] No traded volume in the last 24 hours.`)
        }

        // 0. 成交量百分位分布（有時間權重）
        const percentiles = [0.1, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]
        const pctMap: Record<string, string> = {}
        for (const p of percentiles) {
          pctMap[`p${_.round(p * 100)}`] = rateStringify(Number(binarySearchRateBI(weightedRanges, totalWeightedVol, BigInt(_.round(p * 1e8)))) / 1e8)
        }
        ymlDump('distribution', pctMap)

        const rawPctMap: Record<string, string> = {}
        for (const p of percentiles) {
          rawPctMap[`p${_.round(p * 100)}`] = rateStringify(Number(binarySearchRateBI(rawRanges, totalRawVol, BigInt(_.round(p * 1e8)))) / 1e8)
        }
        ymlDump('distributionNoDecay', rawPctMap)

        // 1. 最近 2 小時 vs 之前 22 小時（都限定在最近 24 小時視窗內）
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

        // 2. High vs Close 差距分析
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

        // 3. 每小時 high 均值趨勢（只看最近 24 小時有效 candles）
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

        const finalRate = _.clamp(targetRate, cfg1.rateMin, cfg1.rateMax)
        // 低於 FRR 代表現在行情差，改用對照表的短天期，過幾天就能重新定價；
        // 高於 FRR 才值得用 120 天鎖住這個價格。
        const belowFrr = finalRate < frr
        const finalPeriod = belowFrr ? rateToPeriod(cfg1.period, finalRate) : LENDING_PERIOD

        // 目標利率落在「實際借出天期」市場成交量的哪個百分位，用來判讀掛得出去的機率
        const targetPercentile = totalWeightedVol > 0n
          ? (() => {
              const targetBI = BigInt(_.round(targetRate * 1e8))
              let vol = 0n
              for (const { low, high, vol: v } of weightedRanges) {
                if (targetBI < low) break
                vol += targetBI >= high ? v : v * (targetBI - low + 1n) / (high - low + 1n)
              }
              return Number(vol * 10000n / totalWeightedVol) / 10000
            })()
          : null

        ymlDump('pricing', {
          method: 'frr_high24h_interpolation',
          rank: cfg1.rank,
          frr: rateStringify(frr),
          high24h: rateStringify(high24h),
          targetRate,
          targetRateStr: rateStringify(targetRate),
          finalRate,
          finalRateStr: rateStringify(finalRate),
          targetPercentileInMarket: targetPercentile != null ? floatFormatPercent(targetPercentile) : null,
          belowFrr,
          finalPeriod,
          periodSource: belowFrr ? 'rateToPeriod (低於 FRR)' : `fixed ${LENDING_PERIOD}d`,
        })
        if (belowFrr) loggers.log(`[${currency}] rate ${rateStringify(finalRate)} < FRR ${rateStringify(frr)}, using ${finalPeriod}d from period table`)

        const newAutoRenew = trace.newAutoRenew = {
          amount: cfg1.amount,
          currency,
          period: finalPeriod,
          rate: finalRate,
        }

        const walletAvailable = (wallets[`funding:${currency}`] as any)?.availableBalance ?? 0

        // 循序呼叫避免 nonce 衝突：需要已借出與掛單中的金額，才能算出扣除保留金額後可自動借出的上限
        const creditsRaw = await bitfinex.v2AuthReadFundingCredits({ currency })
        const orders = await bitfinex.v2AuthReadFundingOffers({ currency })
        const creditsForCalc = trace.creditsForCalc = _.chain(creditsRaw)
          .filter(({ side }) => side === 1)
          .map(credit => _.pick(credit, ['id', 'amount', 'rate', 'period', 'mtsOpening']))
          .value()
        const creditsAmountSum = trace.creditsAmountSum = _.sumBy(creditsForCalc, 'amount')
        const ordersAmountSum = trace.ordersAmountSum = _.sumBy(orders, 'amount')
        // 帳戶總金額 = 可用 + 已借出 + 掛單中（避免入金後利用率失真）
        const totalAmount = trace.totalAmount = walletAvailable + creditsAmountSum + ordersAmountSum

        // 保留金額：扣除保留金額後，若剩餘可借出上限低於 Bitfinex 最低借出金額，代表已無可借出的餘額，暫停自動借出
        let reserveHold = false
        if (cfg1.reserveAmount > 0) {
          const reserveCap = floatFloor8(totalAmount - cfg1.reserveAmount)
          if (reserveCap < RESERVE_MIN_LENDABLE) {
            reserveHold = true
          } else {
            newAutoRenew.amount = cfg1.amount > 0 ? _.min([cfg1.amount, reserveCap])! : reserveCap
          }
        }
        trace.reserveHold = reserveHold

        ymlDump('newAutoRenew', { ...newAutoRenew, rateStr: rateStringify(newAutoRenew.rate) })
        ymlDump('reserve', {
          reserveAmount: cfg1.reserveAmount,
          totalAmount: floatFormatDecimal(totalAmount, 3),
          reserveHold,
        })

        const settingsChanged = !reserveHold && !_.isMatch(prevAutoRenew ?? {}, newAutoRenew)

        if (reserveHold) {
          trace.autoRenewChanged = !_.isNil(prevAutoRenew)
          if (!_.isNil(prevAutoRenew)) {
            await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
            loggers.log(`Available (${floatFormatDecimal(totalAmount, 2)}) - reserve (${floatFormatDecimal(cfg1.reserveAmount, 2)}) < ${RESERVE_MIN_LENDABLE}, pausing auto-funding`)
            await scheduler.wait(1000)
          } else {
            loggers.log(`Available (${floatFormatDecimal(totalAmount, 2)}) within reserve (${floatFormatDecimal(cfg1.reserveAmount, 2)}), auto-funding stays paused`)
          }
        } else if (!settingsChanged && walletAvailable < 1) {
          trace.autoRenewChanged = false
          loggers.log('Setting of auto-renew no change.')
        } else {
          trace.autoRenewChanged = true
          if (settingsChanged) {
            // 利率/天期有變更：Bitfinex 自動掛單需先停用才能改利率，但「不」取消既有掛單。
            // 停用本身不會取消掛單，既有掛單維持原利率自然成交或到期，避免拆單空窗把全錢包閒置；
            // 重新啟用後 Bitfinex 會以新利率持續自動續借歸還與閒置資金。
            if (!_.isNil(prevAutoRenew)) await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
            loggers.log(`Rate changed to ${rateStringify(newAutoRenew.rate)}, updating auto-funding (offers kept)`)
          } else {
            // 設定未變，但有閒置資金（如到期歸還），直接重新觸發自動掛單讓 Bitfinex 掛出閒置資金
            loggers.log(`Available balance ${floatFormatDecimal(walletAvailable, 2)}, re-triggering auto-funding`)
          }
          await bitfinex.v2AuthWriteFundingAuto({
            ...newAutoRenew,
            rate: floatFloor8(newAutoRenew.rate * 100), // API 要的是百分比
            status: 1,
          }).catch(err => { throw _.set(err, 'data.newAutoRenew', newAutoRenew) })
          await scheduler.wait(1000)
        }

        // 殭屍掛單：Bitfinex 的 auto-renew 只影響「之後新掛的單」，既有掛單會永遠保留原利率。
        // 行情下跌後那些單就卡在市場外永遠不會成交，所以主動取消，讓資金回到可用餘額重新掛出。
        if (!reserveHold) {
          const staleOffers = orders.filter((o: any) => o.rate > finalRate * STALE_OFFER_RATIO)
          if (staleOffers.length > 0) {
            ymlDump('staleOffers', staleOffers.map((o: any) => ({
              id: o.id,
              amount: floatFormatDecimal(o.amount, 2),
              rate: rateStringify(o.rate),
              period: o.period,
            })))
            for (const offer of staleOffers) {
              await rest.cancelFundingOffer({ id: offer.id })
                .then(() => loggers.log(`Cancelled stale offer ${offer.id}: ${floatFormatDecimal(offer.amount, 2)} @ ${rateStringify(offer.rate)} (target ${rateStringify(finalRate)})`))
                .catch((err: any) => loggers.error([_.set(err, 'data.staleOffer', offer)]))
              await scheduler.wait(1000)
            }
            // 取消後資金回到可用餘額，重新觸發自動掛單讓它以新利率掛出。
            // 此時 auto-renew 已是啟用狀態，直接送 status:1 會被 Bitfinex 以
            // 「Auto-renew already active」(10001) 拒絕，必須先停用再啟用。
            await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
            await scheduler.wait(1000)
            await bitfinex.v2AuthWriteFundingAuto({
              ...newAutoRenew,
              rate: floatFloor8(newAutoRenew.rate * 100),
              status: 1,
            }).catch(err => { throw _.set(err, 'data.newAutoRenew', newAutoRenew) })
            await scheduler.wait(1000)
          }
        }
      } catch (err) {
        if (!(err instanceof SkipError)) throw err
        loggers.log(err.message)
      }

      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      if (wallet.balance >= Number.EPSILON && !_.isNil(trace.newAutoRenew)) {
        const db1: Record<string, any> = db.notified?.[currency] ?? {}
        const autoRenew = _.pickBy(trace.newAutoRenew, _.isNumber)

        // 沿用前面計算自動借出上限時已取得的已借出／掛單資料，避免重複呼叫造成 nonce 衝突
        const creditsForCalc = trace.creditsForCalc
        const creditsAmountSum = trace.creditsAmountSum
        const creditIds = _.sortBy(_.map(creditsForCalc, 'id'))
        const ordersAmountSum = trace.ordersAmountSum
        const totalAmount = trace.totalAmount
        // 綜合 APR（基於帳戶總金額）、借出 APR（僅借出部分，不受入金稀釋）
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
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, totalAmount)})${cfg1.reserveAmount > 0 ? `\n保留金額: ${floatFormatDecimal(cfg1.reserveAmount, 3)} (${trace.reserveHold ? '自動借出已暫停' : '借出中'})` : ''}
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

        const sendAndSave = async () => {
          const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
          _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: totalAmount, creditIds })
        }
        const reuseMsgId = _.isNumber(db1.msgId)
          && floatIsEqual(db1.balance, totalAmount)
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
