/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 取得過去 24 小時的 1 分鐘 Funding Candles（實際成交利率）
2. 每根 K 線展開為 [low, high] 利率區間，volume × 指數時間衰減為權重（半衰期 4 小時）
3. 利用二分搜尋法，在加權累積分佈中找出 rank 百分位數對應的利率
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

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
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

        // 定價：24h Funding Candles + 時間衰減 + 二分搜尋
        // 每根 K 線展開為 [low, high] 利率區間，volume × exp(-λΔt) 為權重（半衰期 4 小時）
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
        const ranges: [bigint, bigint, bigint][] = candles
          .map(({ open, close, high, low, volume, mts }): [bigint, bigint, bigint] => {
            const timeWeight = Math.exp(-DECAY_LAMBDA * (now - mts))
            return [
              BigInt(_.round((_.min([open, close, high, low]) as number) * 1e8)),
              BigInt(_.round((_.max([open, close, high, low]) as number) * 1e8)),
              BigInt(_.round(volume * timeWeight * 1e8)),
            ]
          })
          .filter(([,, volume]) => volume > 0n)
          .sort((a, b) => Number(a[0] - b[0]) || Number(a[1] - b[1]) || Number(a[2] - b[2]))

        // sum duplicate ranges
        for (let i = 1; i < ranges.length; i++) {
          if (ranges[i][0] !== ranges[i - 1][0] || ranges[i][1] !== ranges[i - 1][1]) continue
          ranges[i - 1][2] += ranges[i][2]
          ranges.splice(i, 1)
          i--
        }

        if (ranges.length === 0) throw new SkipError(`[${currency}] No valid candle data.`)

        let [lowestRate, highestRate, totalVolume] = [ranges[0][0], ranges[0][1], 0n]
        for (const [low, high, volume] of ranges) {
          if (high > highestRate) highestRate = high
          if (low < lowestRate) lowestRate = low
          totalVolume += volume
        }

        ymlDump('candleMetrics', {
          rawCount: candles.length,
          rangesCount: ranges.length,
          lowestRate: rateStringify(Number(lowestRate) / 1e8),
          highestRate: rateStringify(Number(highestRate) / 1e8),
          decayHalfLifeHours: DECAY_HALF_LIFE_MS / 3_600_000,
        })

        // binary search target rate by rank
        const rankBigint = BigInt(_.round(cfg1.rank * 1e8))
        let [bsStart, bsEnd, bsTargetRate, bsTargetDiff] = [lowestRate, highestRate, lowestRate, BigInt(1e8)]
        while (bsStart <= bsEnd) {
          const mid = (bsStart + bsEnd) / 2n
          let midVol = 0n
          for (const [low, high, volume] of ranges) {
            if (mid < low) break
            midVol += mid >= high ? volume : (volume * (mid - low + 1n) / (high - low + 1n))
          }
          const midRank = midVol * BigInt(1e8) / totalVolume
          const diff = bigintAbs(midRank - rankBigint)
          if (diff < bsTargetDiff) { bsTargetRate = mid; bsTargetDiff = diff }
          if (midRank === rankBigint) break
          if (rankBigint < midRank) bsEnd = mid - 1n
          else bsStart = mid + 1n
        }

        const targetRate = Number(bsTargetRate) / 1e8

        // === 完整診斷 log ===

        // 1. 百分位數分布（找出 FRR 污染的邊界在哪）
        const percentiles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]
        const pctMap: Record<string, string> = {}
        for (const p of percentiles) {
          const pRank = BigInt(_.round(p * 1e8))
          let pRate = lowestRate
          let cumVol = 0n
          for (const [low, high, volume] of ranges) {
            if (cumVol + volume >= totalVolume * pRank / BigInt(1e8)) {
              const remaining = totalVolume * pRank / BigInt(1e8) - cumVol
              pRate = volume > 0n ? low + (high - low) * remaining / volume : low
              break
            }
            cumVol += volume
          }
          pctMap[`p${_.round(p * 100)}`] = rateStringify(Number(pRate) / 1e8)
        }
        ymlDump('distribution', pctMap)

        // 2. 成交量集中度分析（看 FRR 污染佔多少比例）
        const frrThreshold = 0.0002 // APR 7.3% 以下視為可能的 FRR 匹配
        const frrThresholdInt = BigInt(_.round(frrThreshold * 1e8))
        let volBelowThreshold = 0n
        let volAboveThreshold = 0n
        let rangesBelowCount = 0
        let rangesAboveCount = 0
        for (const [low, high, volume] of ranges) {
          if (high <= frrThresholdInt) {
            volBelowThreshold += volume
            rangesBelowCount++
          } else if (low >= frrThresholdInt) {
            volAboveThreshold += volume
            rangesAboveCount++
          } else {
            const totalRange = high - low + 1n
            const belowPart = frrThresholdInt - low
            const abovePart = high - frrThresholdInt
            volBelowThreshold += volume * belowPart / totalRange
            volAboveThreshold += volume * abovePart / totalRange
            rangesBelowCount++
            rangesAboveCount++
          }
        }
        ymlDump('volumeConcentration', {
          frrThreshold: rateStringify(frrThreshold),
          belowThresholdVol: floatFormatDecimal(Number(volBelowThreshold) / 1e8, 2),
          aboveThresholdVol: floatFormatDecimal(Number(volAboveThreshold) / 1e8, 2),
          belowThresholdPct: floatFormatPercent(Number(volBelowThreshold) / Number(totalVolume)),
          aboveThresholdPct: floatFormatPercent(Number(volAboveThreshold) / Number(totalVolume)),
          rangesBelowCount,
          rangesAboveCount,
          totalRanges: ranges.length,
        })

        // 3. 時間衰減影響分析（衰減前後的分布比較）
        const rangesRaw: [bigint, bigint, bigint][] = candles
          .map(({ open, close, high, low, volume }): [bigint, bigint, bigint] => [
            BigInt(_.round((_.min([open, close, high, low]) as number) * 1e8)),
            BigInt(_.round((_.max([open, close, high, low]) as number) * 1e8)),
            BigInt(_.round(volume * 1e8)),
          ])
          .filter(([,, v]) => v > 0n)
          .sort((a, b) => Number(a[0] - b[0]) || Number(a[1] - b[1]) || Number(a[2] - b[2]))
        for (let i = 1; i < rangesRaw.length; i++) {
          if (rangesRaw[i][0] !== rangesRaw[i - 1][0] || rangesRaw[i][1] !== rangesRaw[i - 1][1]) continue
          rangesRaw[i - 1][2] += rangesRaw[i][2]
          rangesRaw.splice(i, 1)
          i--
        }
        let totalVolRaw = 0n
        for (const [,, v] of rangesRaw) totalVolRaw += v
        const rawPctMap: Record<string, string> = {}
        for (const p of percentiles) {
          const pRank = BigInt(_.round(p * 1e8))
          let pRate = rangesRaw[0]?.[0] ?? 0n
          let cumVol = 0n
          for (const [low, high, volume] of rangesRaw) {
            if (cumVol + volume >= totalVolRaw * pRank / BigInt(1e8)) {
              const remaining = totalVolRaw * pRank / BigInt(1e8) - cumVol
              pRate = volume > 0n ? low + (high - low) * remaining / volume : low
              break
            }
            cumVol += volume
          }
          rawPctMap[`p${_.round(p * 100)}`] = rateStringify(Number(pRate) / 1e8)
        }
        ymlDump('distributionNoDecay', rawPctMap)
        ymlDump('decayComparison', {
          totalVolWeighted: floatFormatDecimal(Number(totalVolume) / 1e8, 2),
          totalVolRaw: floatFormatDecimal(Number(totalVolRaw) / 1e8, 2),
          retentionPct: floatFormatPercent(Number(totalVolume) / Number(totalVolRaw)),
        })

        // 4. 最近 2 小時 vs 全天的利率比較
        const recentCutoff = now - 2 * 60 * 60 * 1000
        const recentCandles = candles.filter(c => +c.mts >= recentCutoff)
        const olderCandles = candles.filter(c => +c.mts < recentCutoff)
        const avgRate = (list: typeof candles): number => {
          let sumRateVol = 0; let sumVol = 0
          for (const c of list) {
            if (c.volume <= 0) continue
            const mid = (Math.min(c.open, c.close, c.high, c.low) + Math.max(c.open, c.close, c.high, c.low)) / 2
            sumRateVol += mid * c.volume; sumVol += c.volume
          }
          return sumVol > 0 ? sumRateVol / sumVol : 0
        }
        ymlDump('recentVsOlder', {
          recent2h: { count: recentCandles.length, avgRate: rateStringify(avgRate(recentCandles)), totalVol: floatFormatDecimal(_.sumBy(recentCandles, 'volume'), 2) },
          older22h: { count: olderCandles.length, avgRate: rateStringify(avgRate(olderCandles)), totalVol: floatFormatDecimal(_.sumBy(olderCandles, 'volume'), 2) },
        })

        // 5. High vs Close 比較（看 FRR 匹配拉低 close 的程度）
        const highCloseGaps = candles
          .filter(c => c.volume > 0 && c.high > 0)
          .map(c => ({ gap: c.high - c.close, gapPct: (c.high - c.close) / c.high, volume: c.volume }))
        const significantGaps = highCloseGaps.filter(g => g.gapPct > 0.3)
        ymlDump('highCloseAnalysis', {
          totalCandles: highCloseGaps.length,
          avgGapPct: floatFormatPercent(_.meanBy(highCloseGaps, 'gapPct')),
          medianGapPct: floatFormatPercent(_.sortBy(highCloseGaps, 'gapPct')[Math.floor(highCloseGaps.length / 2)]?.gapPct ?? 0),
          significantGapCount: significantGaps.length,
          significantGapAvgVol: floatFormatDecimal(_.meanBy(significantGaps, 'volume') ?? 0, 2),
          normalGapAvgVol: floatFormatDecimal(_.meanBy(highCloseGaps.filter(g => g.gapPct <= 0.3), 'volume') ?? 0, 2),
        })

        // 6. 每小時利率趨勢（看是否有時段效應）
        const hourlyBuckets: Record<number, { sumRate: number, sumVol: number }> = {}
        for (const c of candles) {
          if (c.volume <= 0) continue
          const hour = new Date(c.mts).getUTCHours()
          if (!hourlyBuckets[hour]) hourlyBuckets[hour] = { sumRate: 0, sumVol: 0 }
          const mid = (Math.min(c.open, c.close, c.high, c.low) + Math.max(c.open, c.close, c.high, c.low)) / 2
          hourlyBuckets[hour].sumRate += mid * c.volume
          hourlyBuckets[hour].sumVol += c.volume
        }
        const hourlyRates: Record<string, string> = {}
        for (const h of _.sortBy(_.keys(hourlyBuckets).map(Number))) {
          const b = hourlyBuckets[h]
          hourlyRates[`${String(h).padStart(2, '0')}:00`] = `${rateStringify(b.sumVol > 0 ? b.sumRate / b.sumVol : 0)} vol=${floatFormatDecimal(b.sumVol, 0)}`
        }
        ymlDump('hourlyRates', hourlyRates)

        ymlDump('pricing', {
          method: 'candle_range_bs',
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
