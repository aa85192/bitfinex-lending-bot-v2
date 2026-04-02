/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 取得過去 24 小時的 1 分鐘 Funding Candles
2. 每根 K 線取 high（最高成交利率），只用指數時間衰減為權重（半衰期 4 小時，不乘 volume）
3. 在加權累積分佈中以 rank 百分位數找出目標利率
4. 夾住在 rateMin ~ rateMax 之間後，設定自動出借

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
const DECAY_HALF_LIFE_MS = 4 * 60 * 60 * 1000 // 時間衰減半衰期：4 小時
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_MS
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

// 在已按利率升序排列、以 weight 為量的分佈中，找出 rank 百分位對應的利率
function rankRate (sorted: Array<{ rate: number, weight: number }>, total: number, rank: number): number {
  const targetCum = total * rank
  let cum = 0
  for (const { rate, weight } of sorted) {
    cum += weight
    if (cum >= targetCum) return rate
  }
  return sorted.at(-1)!.rate
}

const ZodConfigPeriod = z.record(
  z.coerce.number().int().min(2).max(120),
  z.number().positive(),
).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.5),
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

        // 定價：每根 K 線的 high 為代表利率，只用指數時間衰減為權重（不乘 volume）
        // high 是該分鐘最高成交利率，跳過 FRR 自動匹配拉低 close 的影響
        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 1440,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          timeframe: '1m',
        })

        const now = Date.now()
        const rateEntries = candles
          .filter(c => c.volume > 0 && c.high > 0)
          .map(c => ({
            rate: Math.max(c.open, c.close, c.high, c.low),
            weight: Math.exp(-DECAY_LAMBDA * (now - +c.mts)),
          }))
          .filter(({ weight }) => weight > Number.EPSILON)
          .sort((a, b) => a.rate - b.rate)

        const totalWeight = _.sumBy(rateEntries, 'weight')

        ymlDump('candleMetrics', {
          rawCount: candles.length,
          validEntries: rateEntries.length,
          lowestRate: rateEntries[0] != null ? rateStringify(rateEntries[0].rate) : null,
          highestRate: rateEntries.at(-1) != null ? rateStringify(rateEntries.at(-1)!.rate) : null,
          decayHalfLifeHours: DECAY_HALF_LIFE_MS / 3_600_000,
        })

        if (rateEntries.length === 0 || totalWeight <= 0) {
          throw new SkipError(`[${currency}] No valid candle data.`)
        }

        const targetRate = rankRate(rateEntries, totalWeight, cfg1.rank)

        // === 診斷 log ===

        // 1. 百分位數分布（有衰減），用 rankRate 保證單調遞增
        const percentiles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]
        const pctMap: Record<string, string> = {}
        for (const p of percentiles) pctMap[`p${_.round(p * 100)}`] = rateStringify(rankRate(rateEntries, totalWeight, p))
        ymlDump('distribution', pctMap)

        // 2. 利率閾值分析（APR 7.3% 以下視為 FRR 區間）
        const frrThreshold = 0.0002
        const weightBelow = _.sumBy(rateEntries.filter(e => e.rate < frrThreshold), 'weight')
        const weightAbove = _.sumBy(rateEntries.filter(e => e.rate >= frrThreshold), 'weight')
        ymlDump('thresholdAnalysis', {
          frrThreshold: rateStringify(frrThreshold),
          belowCount: rateEntries.filter(e => e.rate < frrThreshold).length,
          aboveCount: rateEntries.filter(e => e.rate >= frrThreshold).length,
          belowWeightPct: floatFormatPercent(weightBelow / totalWeight),
          aboveWeightPct: floatFormatPercent(weightAbove / totalWeight),
        })

        // 3. 無衰減分布對比（等權重 = 每根 K 線 weight 1）
        const rawPctMap: Record<string, string> = {}
        for (const p of percentiles) rawPctMap[`p${_.round(p * 100)}`] = rateStringify(rankRate(rateEntries, rateEntries.length, p))
        ymlDump('distributionNoDecay', rawPctMap)

        // 4. 最近 2 小時 vs 全天
        const recentCutoff = now - 2 * 60 * 60 * 1000
        const recentCandles = candles.filter(c => +c.mts >= recentCutoff)
        const olderCandles = candles.filter(c => +c.mts < recentCutoff)
        const avgHigh = (list: typeof candles): number => {
          const highs = list.filter(c => c.volume > 0 && c.high > 0).map(c => Math.max(c.open, c.close, c.high, c.low))
          return highs.length > 0 ? _.mean(highs) : 0
        }
        ymlDump('recentVsOlder', {
          recent2h: { count: recentCandles.length, avgHigh: rateStringify(avgHigh(recentCandles)), totalVol: floatFormatDecimal(_.sumBy(recentCandles.filter(c => c.volume > 0), 'volume'), 2) },
          older22h: { count: olderCandles.length, avgHigh: rateStringify(avgHigh(olderCandles)), totalVol: floatFormatDecimal(_.sumBy(olderCandles.filter(c => c.volume > 0), 'volume'), 2) },
        })

        // 5. High vs Close 差距分析
        const highCloseGaps = candles
          .filter(c => c.volume > 0 && c.high > 0)
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

        // 6. 每小時 high 均值趨勢
        const hourlyBuckets: Record<number, { sumRate: number, count: number }> = {}
        for (const c of candles) {
          if (c.volume <= 0 || c.high <= 0) continue
          const hour = new Date(+c.mts).getUTCHours()
          if (!hourlyBuckets[hour]) hourlyBuckets[hour] = { sumRate: 0, count: 0 }
          hourlyBuckets[hour].sumRate += Math.max(c.open, c.close, c.high, c.low)
          hourlyBuckets[hour].count++
        }
        const hourlyRates: Record<string, string> = {}
        for (const h of _.sortBy(_.keys(hourlyBuckets).map(Number))) {
          const b = hourlyBuckets[h]
          hourlyRates[`${String(h).padStart(2, '0')}:00`] = `${rateStringify(b.count > 0 ? b.sumRate / b.count : 0)} cnt=${b.count}`
        }
        ymlDump('hourlyRates', hourlyRates)

        ymlDump('pricing', {
          method: 'candle_high_decay',
          rank: cfg1.rank,
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
            rate: floatFloor8(newAutoRenew.rate * 100), // percentage of rate
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
