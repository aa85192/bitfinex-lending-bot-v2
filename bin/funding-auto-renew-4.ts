/*
yarn tsx ./bin/funding-auto-renew-4.ts

多天期分散策略：放棄 auto-renew，改用多筆手動掛單。
利率演算法沿用 v3：以 24 小時 1 分鐘 K 線加權成交量分佈，在 rank 百分位找目標利率。

解決的問題：
1. 成交機率：借款人需要 30 天？有 30 天訂單；需要 2 天？有 2 天訂單，不再只能命中一個天數。
2. 到期分散：不會所有資金同一天到期，避免集中遇到利率低谷。
3. 完整利率分散效果：不再受單一天數制約。

做法：
1. 取消所有 pending 掛單（active credit 保留不動）
2. 重新讀取 funding 錢包餘額（取得剛釋出的可用金額）
3. 依 periodSplit 設定，把可用餘額按權重拆分
4. 各天期呼叫 v2AuthWriteFundingOfferNew 逐筆掛單
5. 若某天期分到金額 < minOrderSize，跳過

設定範例（INPUT_AUTO_RENEW_4 環境變數，YAML 格式）：
USD:
  rank: 0.8
  rateMin: 0.0002
  rateMax: 0.01
  periodSplit:
    - days: 2
      weight: 1
    - days: 7
      weight: 2
    - days: 14
      weight: 2
    - days: 30
      weight: 1
  minOrderSize: 50
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
  floatFloor8,
  floatFormatDecimal,
  floatFormatPercent,
  parseYaml,
  progressPercent,
  rateStringify,
} from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:wtkuo_${filename}`
const RATE_MIN = 0.0001 // APR 3.65%
const WINDOW_MS = 24 * 60 * 60 * 1000
const BUCKET_MS = 30 * 60 * 1000
const WINDOW_BUCKETS = Math.ceil(WINDOW_MS / BUCKET_MS) // 48
const WEIGHT_SCALE = 1_000_000n
const RATE_SCALE = 100_000_000n
const TIME_WEIGHT_MIN_BI = 850_000n   // 24h 前 bucket 的時間權重：0.85
const TIME_WEIGHT_MAX_BI = 1_000_000n // 最新 bucket 的時間權重：1.0
const TIME_WEIGHT_MIN = Number(TIME_WEIGHT_MIN_BI) / 1e6
const TIME_WEIGHT_MAX = Number(TIME_WEIGHT_MAX_BI) / 1e6

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

// 二分搜尋（BigInt 版）：找出累積加權體積 ≈ totalVol * rank 的利率
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

// ─── Config Schema ─────────────────────────────────────────────────────────────

const ZodPeriodSplitEntry = z.object({
  days: z.coerce.number().int().min(2).max(120),
  weight: z.coerce.number().positive(),
})

const ZodConfigCurrency = z.object({
  rank: z.coerce.number().min(0).max(1).default(0.8),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  periodSplit: z.array(ZodPeriodSplitEntry).min(1),
  minOrderSize: z.coerce.number().positive().default(50), // Bitfinex 最小掛單額
})

const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

const ZodDb = z.object({
  schema: z.literal(1),
  notified: z.record(
    z.string(),
    z.object({
      balance: z.number(),
      creditIds: z.array(z.number().int()),
      msgId: z.number().int(),
    }).nullish().catch(null),
  ).nullish().catch(null),
}).catch({ schema: 1 })

class SkipError extends Error {}

// ─── Main ──────────────────────────────────────────────────────────────────────

export async function main (): Promise<void> {
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  ymlDump('runtime', {
    script: import.meta.url,
    githubSha: process.env.GITHUB_SHA ?? null,
    node: process.version,
    timeWeightRange: `${TIME_WEIGHT_MIN} ~ ${TIME_WEIGHT_MAX} (linear, ${BUCKET_MS / 60000}min buckets)`,
  })

  const cfg = ZodConfig.parse(parseYaml(getenv('INPUT_AUTO_RENEW_4', '')))
  const db = ZodDb.parse((await bitfinex.v2AuthReadSettings([DB_KEY]).catch(() => ({})))[DB_KEY.slice(4)])
  ymlDump('db', db)

  for (const [currency, cfg1] of _.entries(cfg)) {
    const trace: Record<string, any> = { currency, cfg1 }
    try {
      ymlDump(`cfg.${currency}`, {
        currency,
        ...cfg1,
        rateMinStr: rateStringify(cfg1.rateMin),
        rateMaxStr: rateStringify(cfg1.rateMax),
      })

      // ── 1. 取消所有 pending 掛單，釋放可用餘額 ─────────────────────────────
      await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency })
      await scheduler.wait(1000) // 等待取消生效

      // ── 2. 重新讀取錢包，取得釋出後的可用餘額 ─────────────────────────────
      const wallets = _.mapKeys(
        await bitfinex.v2AuthReadWallets(),
        ({ type, currency: c }) => `${type}:${c}`,
      )
      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      ymlDump(`wallet.${currency}`, { balance: wallet.balance })

      // ── 3. 取得利率（沿用 v3 的 weighted candle 演算法）───────────────────
      const now = Date.now()
      const candles = await Bitfinex.v2CandlesHist({
        aggregation: 30,
        currency,
        limit: 10000,
        periodEnd: 30,
        periodStart: 2,
        sort: BitfinexSort.DESC,
        start: new Date(now - WINDOW_MS),
        end: new Date(now),
        timeframe: '1m',
      })

      const validCandles = candles.filter(c => c.volume > 0 && c.high > 0)
      const weightedRanges = buildRangesBI(validCandles, now, true)
      const totalWeightedVol = weightedRanges.reduce((s, r) => s + r.vol, 0n)

      ymlDump('candleMetrics', {
        rawCount: candles.length,
        validEntries: validCandles.length,
        lowestRate: weightedRanges[0] != null ? rateStringify(Number(weightedRanges[0].low) / 1e8) : null,
        highestRate: weightedRanges.at(-1) != null ? rateStringify(Number(weightedRanges.at(-1)!.high) / 1e8) : null,
      })

      if (weightedRanges.length === 0 || totalWeightedVol <= 0n) {
        throw new SkipError(`[${currency}] No valid candle data in the last 24 hours.`)
      }

      const rankBI = BigInt(_.round(cfg1.rank * 1e8))
      const targetRateRaw = Number(binarySearchRateBI(weightedRanges, totalWeightedVol, rankBI)) / 1e8
      const targetRate = _.clamp(targetRateRaw, cfg1.rateMin, cfg1.rateMax)
      trace.targetRate = targetRate

      ymlDump('pricing', {
        method: 'candle_range_volume_linear_decay',
        rank: cfg1.rank,
        targetRateStr: rateStringify(targetRate),
      })

      // ── 4. 依權重拆分餘額，計算各天期掛單金額 ─────────────────────────────
      const availableBalance = wallet.balance
      if (availableBalance < cfg1.minOrderSize) {
        throw new SkipError(
          `[${currency}] Available balance ${availableBalance} < minOrderSize ${cfg1.minOrderSize}. Skipping.`,
        )
      }

      const totalWeight = _.sumBy(cfg1.periodSplit, 'weight')
      const splits = cfg1.periodSplit
        .map(({ days, weight }) => ({
          days,
          weight,
          amount: floatFloor8(availableBalance * weight / totalWeight),
        }))
        .filter(s => s.amount >= cfg1.minOrderSize)

      if (splits.length === 0) {
        throw new SkipError(
          `[${currency}] No period slot meets minOrderSize ${cfg1.minOrderSize} after weight split. Balance: ${availableBalance}`,
        )
      }

      ymlDump('splits', splits.map(s => ({
        days: s.days,
        amount: floatFormatDecimal(s.amount, 2),
        rate: rateStringify(targetRate),
      })))

      // ── 5. 逐筆掛單 ───────────────────────────────────────────────────────
      const placed: Array<{ days: number, amount: number, rateStr: string }> = []
      for (const split of splits) {
        try {
          await bitfinex.v2AuthWriteFundingOfferNew({
            currency,
            type: 'LIMIT',
            amount: split.amount,
            rate: floatFloor8(targetRate * 100), // API 要的是百分比（同 v2AuthWriteFundingAuto）
            period: split.days,
          })
          placed.push({ days: split.days, amount: split.amount, rateStr: rateStringify(targetRate) })
          await scheduler.wait(300) // 避免 nonce 衝突
        } catch (err) {
          loggers.error([`[${currency}] Failed to place offer for ${split.days} days:`, err])
        }
      }

      trace.placed = placed
      ymlDump('placed', placed)

      // ── 6. 等待掛單生效，取得最新狀態供 Telegram 通知 ─────────────────────
      await scheduler.wait(1000)

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

      // ── 7. 組成 Telegram 通知 ──────────────────────────────────────────────
      const nowts = dayjs().utcOffset(8)
      const splitLines = placed
        .map(p => `  ${p.days}天: ${floatFormatDecimal(p.amount, 2)} @ ${floatFormatPercent(targetRate, 6)}`)
        .join('\n')

      const msgText = [
        telegram.tgMdEscape(`# ${filename}: ${currency} 狀態

投資額: ${floatFormatDecimal(totalAmount, 3)}
已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, totalAmount)})
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, totalAmount)})
本次掛單:
  目標利率: ${floatFormatPercent(targetRate, 6)} (APR: ${floatFormatPercent(targetRate * 365)})
  天期分佈:
${splitLines}
收益率:
  借出APR: ${floatFormatPercent(borrowedApr)}
  綜合APR: ${floatFormatPercent(portfolioApr)}`),
        `更新: ${telegram.tgMdEscape(nowts.format('M/D HH:mm'))}\n`,
        '**>```',
        ymlStringify({ credits }),
        '```||',
      ].join('\n')

      const db1: Record<string, any> = db.notified?.[currency] ?? {}
      const sendAndSave = async () => {
        const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText })
        _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: totalAmount, creditIds })
      }
      const reuseMsgId = _.isNumber(db1.msgId)
        && db1.balance === totalAmount
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
    } catch (err) {
      if (err instanceof SkipError) {
        loggers.log(err.message)
      } else {
        _.update(err, `data.main.${currency}`, old => old ?? trace)
        loggers.error([err])
      }
    } finally {
      loggers.log('- - -\n')
    }
  }

  ymlDump('newDb', db)
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any }).catch(loggers.error)
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
