/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 取得過去一天內的每分鐘 K 線圖
2. 對每根 K 線施加時間衰減權重（近期 K 線權重較高）
3. 計算 Volume Ratio 偵測流動性枯竭
4. 流動性不足時，將 FRR 作為合成錨點混入分布
5. 利用二分搜尋法，找出最接近 totalVolume * rank 的利率
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import { dateStringify, floatFloor8, floatFormatDecimal, floatFormatPercent, parseYaml, progressPercent, rateStringify } from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:taichunmin_${filename}`
const RATE_MIN = 0.0001 // APR 3.65%
const FRR_SPREAD_PCT = 0.05 // FRR 合成 range 的寬度（FRR 的 ±5%），無需調整
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

;(BigInt as any).prototype.toJSON ??= function () { // hack to support JSON.stringify
  return this.toString()
}

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

const ZodConfigPeriod = z.record(z.string(), z.number().positive()).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
  // === 新增：時間衰減與 FRR 混入參數 ===
  decayHalfLife: z.coerce.number().positive().default(4), // 時間衰減半衰期（小時），預設 4 小時
  frrTrustThreshold: z.coerce.number().positive().max(1).default(0.5), // volRatio 低於此值時開始混入 FRR（必須 > 0，避免除零）
  frrMaxWeight: z.coerce.number().min(0).default(3), // FRR 合成量最多佔 totalVolume 的倍數
})

const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

const ZodDb = z.object({
  schema: z.literal(1), // 用來辨識資料結構版本，方便未來升級
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

  // 讀取並驗證設定
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

      // 取得該貨幣最新一筆融資統計
      const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency, limit: 1 }))[0]
      ymlDump('fundingStats', {
        currency,
        date: dateStringify(fundingStats.mts),
        frrStr: rateStringify(fundingStats.frr),
      })

      // 修改 autoRenew 的參數
      try {
        // 取得該貨幣自動出借的設定
        const prevAutoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency })
        if (_.isNil(prevAutoRenew)) ymlDump('prevAutoRenew', { status: false })
        else {
          ymlDump('prevAutoRenew', {
            ...prevAutoRenew,
            rateStr: rateStringify(prevAutoRenew.rate),
          })
        }

        // get candles
        const yesterday = dayjs().add(-1, 'day').add(-1, 'second').toDate()
        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 10000,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          start: yesterday,
          timeframe: '1m',
        })

        // === 新增：計算時間衰減參數 ===
        const now = Date.now()
        // 半衰期轉換為衰減常數：decay = ln(2) / halfLife
        // 在 0~1 的歸一化時間軸上（0=現在, 1=24小時前），halfLife 以小時為單位需除以 24
        const decayLambda = Math.LN2 / (cfg1.decayHalfLife / 24)

        // === 新增：計算 Volume Ratio（流動性偵測）===
        const recentCutoffMs = dayjs().add(-2, 'hour').valueOf()
        let recentVolRaw = 0
        let totalVolRaw = 0
        for (const c of candles) {
          const vol = c.volume
          totalVolRaw += vol
          if (c.mts >= recentCutoffMs) recentVolRaw += vol
        }
        // 24h 分成 12 個 2h 區段的均值
        const avgVol2h = totalVolRaw / 12
        const volRatio = avgVol2h > 0 ? recentVolRaw / avgVol2h : 0

        // frrTrust: 0 = 完全信任市場分布, 1 = 完全依賴 FRR
        const frrTrust = Math.max(0, Math.min(1, 1 - volRatio / cfg1.frrTrustThreshold))

        ymlDump('liquidityMetrics', {
          recentVolRaw: floatFormatDecimal(recentVolRaw, 2),
          totalVolRaw: floatFormatDecimal(totalVolRaw, 2),
          avgVol2h: floatFormatDecimal(avgVol2h, 2),
          volRatio: floatFormatDecimal(volRatio, 4),
          frrTrust: floatFormatDecimal(frrTrust, 4),
        })

        // === 修改：ranges 加入時間衰減權重 ===
        const ranges = _.chain(candles)
          .map((candle) => {
            const { open, close, high, low, volume, mts } = candle
            // 計算時間衰減權重
            const age = (now - mts) / (24 * 3600 * 1000) // 0（現在）~1（24小時前）
            const timeWeight = Math.exp(-decayLambda * age)
            // 將 volume 乘以時間衰減權重
            const weightedVolume = volume * timeWeight
            return _.map([
              _.min([open, close, high, low]), // low * 1e8
              _.max([open, close, high, low]), // high * 1e8
              weightedVolume, // weightedVolume（浮點數，稍後轉 bigint）
            ], (num: number) => BigInt(_.round(num * 1e8)))
          })
          .filter(([low, high, volume]) => volume > 0n)
          .sortBy([0, 1, 2])
          .value()
        // sum duplicate ranges
        for (let i = 1; i < ranges.length; i++) {
          const [low, high, volume] = ranges[i]
          if (low !== ranges[i - 1][0] || high !== ranges[i - 1][1]) continue
          ranges[i - 1][2] += volume
          ranges.splice(i, 1)
          i--
        }
        if (ranges.length === 0) throw new SkipError('Skip to change autoRenew because no candles.')

        // for lowest rate and highest rate
        let [lowestRate, highestRate, totalVolume] = [ranges[0][0], ranges[0][1], 0n]
        for (const [low, high, volume] of ranges) {
          if (high > highestRate) highestRate = high
          if (low < lowestRate) lowestRate = low
          totalVolume += volume
        }

        // BUG 2 改善：記錄衰減前後的 volume 比較，監控衰減強度是否合理
        // totalVolRaw 是未衰減的原始成交量，totalVolume 是衰減加權後的（* 1e8）
        const totalVolWeighted = Number(totalVolume) / 1e8
        ymlDump('decayImpact', {
          totalVolRaw: floatFormatDecimal(totalVolRaw, 4),
          totalVolWeighted: floatFormatDecimal(totalVolWeighted, 4),
          decayRetentionPct: totalVolRaw > 0
            ? floatFormatPercent(totalVolWeighted / totalVolRaw)
            : 'N/A',
          halfLifeHours: cfg1.decayHalfLife,
          rangesCount: ranges.length,
        })

        // === 新增：FRR 合成錨點混入 ===
        if (frrTrust > 0 && totalVolume > 0n) {
          // 檢查 FRR 資料是否可用
          const frrAvailable = !_.isNil(fundingStats?.frr) && Number.isFinite(fundingStats.frr) && fundingStats.frr > 0

          if (!frrAvailable) {
            // 流動性不足但 FRR 資料不可用 — 這是需要被注意的狀態
            loggers.error(`[${currency}] WARNING: Low liquidity detected (frrTrust=${floatFormatDecimal(frrTrust, 4)}) but FRR data unavailable (frr=${fundingStats?.frr}). FRR fallback SKIPPED — rate based on sparse market data only.`)
          } else {
            const frr = fundingStats.frr
            const frrInt = BigInt(Math.round(frr * 1e8))
            const spread = BigInt(Math.max(1, Math.round(frr * FRR_SPREAD_PCT * 1e8)))
            const syntheticLow = frrInt - spread
            const syntheticHigh = frrInt + spread

            // BUG 1 修復：用 bigint basis-points 乘法，避免 Number(totalVolume) 超過 MAX_SAFE_INTEGER
            // syntheticVol = totalVolume * frrTrust * frrMaxWeight
            // 將浮點乘數轉為 basis points (萬分位) 再用 bigint 運算
            const frrTrustBp = BigInt(Math.round(frrTrust * 10000))
            const frrMaxWeightBp = BigInt(Math.round(cfg1.frrMaxWeight * 10000))
            const syntheticVol = totalVolume * frrTrustBp * frrMaxWeightBp / 10000n / 10000n

            if (syntheticVol > 0n) {
              // 記錄混入前的 totalVolume，用於 log 語義正確（BUG 5 修正）
              const totalVolumeBeforeInjection = totalVolume

              ranges.push([syntheticLow, syntheticHigh, syntheticVol])
              ranges.sort((a, b) => Number(a[0] - b[0]) || Number(a[1] - b[1]))

              // D3 修正：FRR 插入後重新執行 duplicate merge
              for (let i = 1; i < ranges.length; i++) {
                if (ranges[i][0] !== ranges[i - 1][0] || ranges[i][1] !== ranges[i - 1][1]) continue
                ranges[i - 1][2] += ranges[i][2]
                ranges.splice(i, 1)
                i--
              }

              // 更新邊界與總量
              totalVolume += syntheticVol
              if (syntheticLow < lowestRate) lowestRate = syntheticLow
              if (syntheticHigh > highestRate) highestRate = syntheticHigh

              ymlDump('frrInjection', {
                frr: rateStringify(frr),
                syntheticLow: Number(syntheticLow) / 1e8,
                syntheticHigh: Number(syntheticHigh) / 1e8,
                syntheticVol: syntheticVol.toString(),
                totalVolumeBefore: totalVolumeBeforeInjection.toString(),
                totalVolumeAfter: totalVolume.toString(),
                syntheticRatio: floatFormatDecimal(Number(syntheticVol) / Number(totalVolumeBeforeInjection), 2),
                syntheticPct: floatFormatPercent(Number(syntheticVol) / Number(totalVolume)),
              })
            }
          }
        }

        // binary search target rate by rank
        const ctxBs: Record<string, any> = {
          rank: BigInt(_.round(cfg1.rank * 1e8)),
          cnt: 0n,
          start: lowestRate,
          end: highestRate,
        }
        while (ctxBs.start <= ctxBs.end) {
          ctxBs.mid = (ctxBs.start + ctxBs.end) / 2n

          // calculate volume for mid
          ctxBs.midVol = 0n
          for (const [low, high, volume] of ranges) {
            if (ctxBs.mid < low) break // because ranges is sorted
            ctxBs.midVol += ctxBs.mid >= high ? volume : (volume * (ctxBs.mid - low + 1n) / (high - low + 1n))
          }
          ctxBs.midRank = ctxBs.midVol * BigInt(1e8) / totalVolume

          // save target rate
          const targetRankDiff = bigintAbs((ctxBs.midRank - ctxBs.rank) as any)
          if (_.isNil(ctxBs.targetRate)) {
            ctxBs.targetRate = ctxBs.mid
            ctxBs.targetRankDiff = targetRankDiff
          } else if (targetRankDiff < ctxBs.targetRankDiff) {
            ctxBs.targetRate = ctxBs.mid
            ctxBs.targetRankDiff = targetRankDiff
          }

          if (ctxBs.midRank === ctxBs.rank) break // found
          if (ctxBs.rank < ctxBs.midRank) ctxBs.end = ctxBs.mid - 1n
          else ctxBs.start = ctxBs.mid + 1n
          ctxBs.cnt++
        }

        // target
        const targetRate = _.clamp(Number(ctxBs.targetRate) / 1e8, cfg1.rateMin, cfg1.rateMax)
        const newAutoRenew = trace.newAutoRenew = {
          amount: cfg1.amount,
          currency,
          period: rateToPeriod(cfg1.period, targetRate),
          rate: targetRate,
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
          await scheduler.wait(1000) // 等待 1 秒鐘，讓掛單生效
        }
      } catch (err) {
        if (!(err instanceof SkipError)) throw err
        loggers.log(err.message)
      }

      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      if (wallet.balance >= Number.EPSILON && !_.isNil(trace.newAutoRenew)) {
        const db1: Record<string, any> = db.notified?.[currency] ?? {}
        const autoRenew = _.pickBy(trace.newAutoRenew, _.isNumber)

        // 並行取得出借中的融資和掛單
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

        const sendAndSave = async (opts: Record<string, unknown> = {}) => {
          const res1 = await telegram.sendMessage({ parse_mode: 'MarkdownV2', text: msgText, ...opts })
          _.set(db, `notified.${currency}`, { msgId: res1.message_id, balance: wallet.balance, creditIds })
        }
        if (trace.autoRenewChanged) {
          // 利率有變 → 刪舊訊息、推播新訊息
          if (_.isNumber(db1.msgId)) await telegram.deleteMessage({ message_id: db1.msgId }).catch(() => {})
          await sendAndSave()
        } else if (_.isNumber(db1.msgId)) {
          // 利率未變 → 靜默 edit 同一則，edit 失敗才靜默發新訊息
          try {
            await telegram.editMessageText({ message_id: db1.msgId, parse_mode: 'MarkdownV2', text: msgText })
          } catch {
            await sendAndSave()
          }
        } else {
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