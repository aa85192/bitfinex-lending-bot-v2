/*
yarn tsx ./bin/funding-auto-renew-2.ts

程式決定借出利率的邏輯：
1. 取得過去 1441 分鐘的 K 線圖
2. 把成交量加總 totalVolume
3. 利用二分搜尋法，找出最接近 totalVolume * rank 的利率
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import JSON5 from 'json5'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import { dateStringify, floatFloor8, floatFormatDecimal, floatFormatPercent, floatIsEqual, progressPercent, rateStringify } from '../lib/helper.mjs'
import { createLoggersByUrl, ymlStringify } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const RATE_MIN = 0.0001 // APR 3.65%
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

const ZodDbNotified = z.object({
  msgId: z.number().int(),
  balance: z.number(),
  creditIds: z.array(z.number().int()),
})
const ZodDb = z.object({
  schema: z.literal(2),
  notified: z.record(z.string(), ZodDbNotified).default({}),
}).catch({ schema: 2, notified: {} })

function ymlDump (key: string, val: any): void {
  loggers.log(_.set({}, key, val))
}

;(BigInt as any).prototype.toJSON ??= function () { // hack to support JSON.stringify
  return this.toString()
}

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

const ZodConfig = z.object({
  amount: z.coerce.number().min(0).default(0),
  currency: z.coerce.string().default('USD'),
  period: z.record(z.coerce.number().int().min(2).max(120), z.number().positive()).default({}),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
})

export async function main (): Promise<void> {
  const cfg = ZodConfig.parse({
    amount: getenv('INPUT_AMOUNT'),
    currency: getenv('INPUT_CURRENCY'),
    period: JSON5.parse(getenv('INPUT_PERIOD')),
    rank: getenv('INPUT_RANK'),
    rateMax: getenv('INPUT_RATE_MAX'),
    rateMin: getenv('INPUT_RATE_MIN'),
  })
  ymlDump('input', {
    ...cfg,
    rateMin: rateStringify(cfg.rateMin),
    rateMax: rateStringify(cfg.rateMax),
  })
  const DB_KEY = `api:${filename}`
  const dbRaw = await bitfinex.v2AuthReadSettings([DB_KEY]).catch(() => ({}))
  const db = ZodDb.parse(dbRaw[DB_KEY.slice(4)] ?? {})
  ymlDump('db', db)

  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency: cfg.currency, limit: 1 }))?.[0]
  ymlDump('fundingStats', {
    currency: cfg.currency,
    date: dateStringify(fundingStats.mts),
    frr: rateStringify(fundingStats.frr),
  })

  // get status of auto funding
  const autoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency: cfg.currency })
  if (_.isNil(autoRenew)) loggers.log({ autoRenew: { status: false } })
  else {
    ymlDump('autoRenew', {
      currency: cfg.currency,
      rate: rateStringify(autoRenew.rate),
      period: autoRenew.period,
      amount: autoRenew.amount,
    })
  }

  // get candles
  const candles = await Bitfinex.v2CandlesHist({
    aggregation: 30,
    currency: cfg.currency,
    limit: 1441, // 1 day + 1 min
    periodEnd: 30,
    periodStart: 2,
    sort: BitfinexSort.DESC,
    timeframe: '1m',
  })

  // ranges
  const yesterday = dayjs().add(-1, 'day').add(-1, 'second').toDate()
  const ranges = _.chain(candles)
    .filter(candle => candle.mts >= yesterday && candle.volume > 0)
    .map(candle => {
      const [open, close, high, low, volume] = _.chain(candle)
        .pick(['open', 'close', 'high', 'low', 'volume'])
        .map(num => BigInt(_.round(num * 1e8)))
        .value()
      return [
        _.min([open, close, high, low]), // min * 1e8
        _.max([open, close, high, low]), // high * 1e8
        volume, // volume
      ] as [bigint, bigint, bigint]
    })
    .sortBy([0, 1, 2])
    .value()
  // sum duplicate ranges
  for (let i = 1; i < ranges.length; i++) {
    const [low, high, volume] = ranges[i]
    if (volume > 0n) {
      if (low !== ranges[i - 1][0] || high !== ranges[i - 1][1]) continue
      ranges[i - 1][2] += volume
    }
    ranges.splice(i, 1)
    i--
  }
  // console.log(`ranges.length = ${ranges.length}, ranges: ${JSON.stringify(_.take(ranges, 10))}`)
  if (ranges.length === 0) {
    loggers.log('Setting of auto-renew no change because no candles.')
    return
  }

  // for lowest rate and highest rate
  let [lowestRate, highestRate, totalVolume] = [ranges[0][0], ranges[0][1], 0n]
  for (const [low, high, volume] of ranges) {
    if (high > highestRate) highestRate = high
    if (low < lowestRate) lowestRate = low
    totalVolume += volume
  }
  // console.log(`lowestRate = ${lowestRate}, highestRate = ${highestRate}, totalVolume = ${totalVolume}`)

  // binary search target rate by rank
  const ctxBs: Record<string, any> = {
    rank: BigInt(_.round(cfg.rank * 1e8)),
    cnt: 0n,
    start: lowestRate,
    end: highestRate,
  }
  // console.log(`ctxBs: ${JSON.stringify(ctxBs)}`)
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
    // console.log(`ctxBs: ${JSON.stringify(ctxBs)}`)
  }

  // target
  const targetRate = _.clamp(Number(ctxBs.targetRate) / 1e8, cfg.rateMin, cfg.rateMax)
  const target = {
    rate: targetRate,
    period: rateToPeriod(cfg.period, targetRate),
  }
  ymlDump('target', { ...target, rate: rateStringify(target.rate) })

  if (_.isMatchWith(autoRenew ?? {}, target, floatIsEqual)) {
    loggers.log('Setting of auto-renew no change.')
  } else {
    if (autoRenew) await bitfinex.v2AuthWriteFundingAuto({ ..._.pick(cfg, ['currency']), status: 0 })
    await bitfinex.v2AuthWriteFundingOfferCancelAll(_.pick(cfg, ['currency']))
    await bitfinex.v2AuthWriteFundingAuto({
      ..._.pick(cfg, ['currency', 'amount']),
      period: target.period,
      rate: floatFloor8(target.rate * 100), // percentage of rate
      status: 1,
    }).catch(err => { throw _.merge(err, { data: { target } }) })
  }

  // 等待掛單生效，取得最新狀態
  await scheduler.wait(1000)
  const wallets = _.keyBy(await bitfinex.v2AuthReadWallets(), w => `${w.type}:${w.currency}`)
  const wallet = wallets[`funding:${cfg.currency}`] ?? { balance: 0 }
  const credits = _.filter(await bitfinex.v2AuthReadFundingCredits({ currency: cfg.currency }), c => c.side === 1)
  const orders = await bitfinex.v2AuthReadFundingOffers({ currency: cfg.currency })
  const creditsAmountSum = _.sumBy(credits, 'amount') ?? 0
  const ordersAmountSum = _.sumBy(orders, 'amount') ?? 0
  const creditIds = _.sortBy(_.map(credits, 'id'))
  loggers.log({ walletBalance: wallet.balance, creditsAmountSum, ordersAmountSum, creditIds })

  if (wallet.balance < Number.EPSILON) return

  const notified = db.notified[cfg.currency]

  // 組成訊息
  const nowts = dayjs()
  const msgText = [
    telegram.tgMdEscape(`# ${filename}: ${cfg.currency} 狀態\n`),
    `投資額: ${floatFormatDecimal(wallet.balance, 3)}`,
    `已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, wallet.balance)})`,
    `掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, wallet.balance)})`,
    `自動掛單設定:`,
    `    利率: ${floatFormatPercent(target.rate, 6)}`,
    `    APR: ${floatFormatPercent(target.rate * 365)}`,
    `    天數: ${target.period}`,
    `\n更新: ${telegram.tgMdEscape(nowts.format('M/D HH:mm'))} \\(${telegram.tgMdDate({ text: '?', date: nowts.toDate(), format: 'r' })}\\)`,
    '',
    `**&gt;\`\`\`\n${ymlStringify(_.map(credits, c => ({
      ..._.pick(c, ['amount', 'period']),
      rate: floatFormatPercent(c.rate, 6),
      apr: floatFormatPercent(c.rate * 365),
      mtsOpening: dayjs(c.mtsOpening).format('MM/DD HH:mm'),
    })))}\n\`\`\`||**`,
  ].filter(Boolean).join('\n')

  if (_.isNumber(notified?.msgId)) {
    const edited = await telegram.editMessageText({ message_id: notified.msgId, text: msgText, parse_mode: 'MarkdownV2' }).catch(loggers.error)
    if (!edited) {
      // edit 失敗（訊息被刪除或過期），改發新訊息
      const res = await telegram.sendMessage({ text: msgText, parse_mode: 'MarkdownV2' }).catch(loggers.error)
      if (res?.message_id) db.notified[cfg.currency] = { msgId: res.message_id, balance: wallet.balance, creditIds }
    }
  } else {
    const res = await telegram.sendMessage({ text: msgText, parse_mode: 'MarkdownV2' }).catch(loggers.error)
    if (res?.message_id) db.notified[cfg.currency] = { msgId: res.message_id, balance: wallet.balance, creditIds }
  }
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) }).catch(loggers.error)
}

export function rateToPeriod (periodMap: z.output<typeof ZodConfig>['period'], rateTarget) {
  const sortedPeriods = _.chain(periodMap)
    .map((v, k) => ({ peroid: _.toSafeInteger(k), rate: _.toFinite(v) }))
    .orderBy(['peroid'], ['desc'])
    .value()
  const periodTarget = _.find(sortedPeriods, ({ peroid, rate }) => rateTarget >= rate)?.peroid ?? 2
  return _.clamp(periodTarget, 2, 120)
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
