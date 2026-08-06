/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 從 funding ticker 取得即時 FRR 與 24 小時最高成交利率（24hHigh），
   兩者皆與 Bitfinex 網頁顯示的數字一致
2. 在 FRR 與 24hHigh 兩點之間，用 rank 當作往 24hHigh 靠近的插值比例：
   targetRate = FRR + rank × max(0, 24hHigh − FRR)
   以 FRR 為下限：24hHigh 低於 FRR 時直接掛 FRR，不會掛得比浮動利率還低
3. 夾住在 rateMin ~ rateMax 之間後，固定 120 天設定自動出借

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
import { getFundingTicker } from '../lib/bitfinex.mjs'
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
// 24h 最高成交利率直接取 funding ticker 的 HIGH，與 Bitfinex 網頁顯示的數字一致。
// 不自己從長天期 K 線推算：長天期成交極稀疏，單筆小額成交就會把「最高」拉走。
// K 線僅供診斷 log 使用，天期區間與 ticker HIGH 對齊（p2~p30）。
const CANDLE_PERIOD = { start: 2, end: 30 }
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  reserveAmount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.8),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
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

        // === 診斷 log ===

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

        // targetRate = FRR 與 24h 最高成交利率之間，以 rank 當作往 24h 最高值靠近的插值比例。
        // 以 FRR 為下限：24h 最高低於 FRR 時，插值會把利率拉到 FRR 以下，
        // 那還不如直接用 FRR 浮動利率出借，因此此時直接掛 FRR。
        const frrFloorApplied = high24h < frr
        const targetRate = frr + cfg1.rank * _.max([0, high24h - frr])!
        const finalRate = _.clamp(targetRate, cfg1.rateMin, cfg1.rateMax)
        const finalPeriod = LENDING_PERIOD

        ymlDump('pricing', {
          method: 'frr_high24h_interpolation',
          frr: rateStringify(frr),
          high24h: rateStringify(high24h),
          high24hSource: 'funding ticker HIGH',
          rank: cfg1.rank,
          frrFloorApplied,
          targetRate,
          targetRateStr: rateStringify(targetRate),
          finalRate,
          finalRateStr: rateStringify(finalRate),
        })
        if (frrFloorApplied) loggers.log(`[${currency}] 24h high (${rateStringify(high24h)}) < FRR (${rateStringify(frr)}), using FRR as floor`)

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
