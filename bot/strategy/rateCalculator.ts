/*
Pure rate-calculation logic extracted from bin/funding-auto-renew-3.ts.

These functions decide the target funding rate from recent 24h candle data:
  1. buildRangesBI:    candles → [low, high, weighted_volume] bigint ranges
  2. binarySearchRateBI: ranges + rank percentile → target rate (bigint, 1e-8 scale)
  3. rateToPeriod:     target rate + period→rate threshold map → period (days)
  4. resolveEffectiveRank: collapses rankSplit (mixed rank) into a single number

Time weighting: linear from TIME_WEIGHT_MAX (newest) to TIME_WEIGHT_MIN (24h old)
across BUCKETS 30-min buckets — newer trades count more.

Deliberately:
- does NOT use FRR (self-reinforcing feedback loop biases it high)
- does NOT use funding book (book = unfilled offers, not real fills)
*/

import _ from 'lodash'
import { z } from 'zod'

// ─── constants ────────────────────────────────────────────────────────
export const RATE_MIN = 0.0001 // APR 3.65%
export const WINDOW_MS = 24 * 60 * 60 * 1000
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000
export const BUCKET_MS = 30 * 60 * 1000 // 30-minute time-weight buckets
export const WINDOW_BUCKETS = Math.ceil(WINDOW_MS / BUCKET_MS) // 48
export const WEIGHT_SCALE = 1_000_000n // time-weight precision 1e-6
export const RATE_SCALE = 100_000_000n // rate precision 1e-8
export const TIME_WEIGHT_MIN_BI = 850_000n // 0.85 (24h ago)
export const TIME_WEIGHT_MAX_BI = 1_000_000n // 1.0 (now)
export const TIME_WEIGHT_MIN = Number(TIME_WEIGHT_MIN_BI) / 1e6
export const TIME_WEIGHT_MAX = Number(TIME_WEIGHT_MAX_BI) / 1e6

// ─── zod schemas ──────────────────────────────────────────────────────
export const ZodConfigPeriod = z.record(
  z.coerce.number().int().min(2).max(120),
  z.number().positive(),
).default({})

export const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.8),
  rankSplit: z.array(z.object({
    ratio: z.coerce.number().min(0).max(1),
    rank: z.coerce.number().min(0).max(1),
  })).default([]),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
})

export const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

export type ConfigCurrency = z.output<typeof ZodConfigCurrency>
export type ConfigPeriod = z.output<typeof ZodConfigPeriod>
export type StrategyConfig = z.output<typeof ZodConfig>

// ─── candle types ─────────────────────────────────────────────────────
export interface Candle {
  mts: Date | number
  open: number
  close: number
  high: number
  low: number
  volume: number
}

// ─── helpers ──────────────────────────────────────────────────────────
function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

// Linear time weight: bucket index 0 (newest) → MAX, WINDOW_BUCKETS-1 → MIN.
export function linearTimeWeightBI (mts: number, nowTs: number): bigint {
  const bucketIndex = Math.min(
    Math.max(Math.floor((nowTs - mts) / BUCKET_MS), 0),
    WINDOW_BUCKETS - 1,
  )
  const decay = (TIME_WEIGHT_MAX_BI - TIME_WEIGHT_MIN_BI) * BigInt(bucketIndex) / BigInt(WINDOW_BUCKETS - 1)
  return TIME_WEIGHT_MAX_BI - decay
}

export interface RangeEntryBI { low: bigint, high: bigint, vol: bigint }

// Convert candles to deduplicated [low, high, weighted_volume] ranges.
export function buildRangesBI (
  candles: Candle[],
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
    const ts = c.mts instanceof Date ? c.mts.getTime() : Number(c.mts)
    const tw = applyTimeWeight ? linearTimeWeightBI(ts, nowTs) : WEIGHT_SCALE
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

// Binary search the rate at which cumulative weighted volume = totalVol * rank.
// rank is in 1e-8 scale (e.g. p80 → 80_000_000n).
export function binarySearchRateBI (
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

// Collapse rankSplit (mixed rank distribution) into a single effective rank.
export function resolveEffectiveRank (cfg1: ConfigCurrency): number {
  if (cfg1.rankSplit.length === 0) return cfg1.rank
  const ratioSum = _.sumBy(cfg1.rankSplit, 'ratio')
  if (ratioSum <= 0) return cfg1.rank
  const normalized = cfg1.rankSplit.map(item => ({ ...item, ratio: item.ratio / ratioSum }))
  return _.sumBy(normalized, item => item.rank * item.ratio)
}

// Pick period (days) for a given target rate, by linear interpolation between
// the two adjacent period thresholds. Higher rate → longer lock.
export function rateToPeriod (periodMap: ConfigPeriod, rateTarget: number): number {
  const ctxPeriod: Record<string, number | null> = { lower: null, target: null, upper: null }
  for (const entry of _.entries(periodMap)) {
    const [period, rate] = [_.toSafeInteger(entry[0]), _.toFinite(entry[1])]
    if (rateTarget >= rate) ctxPeriod.lower = _.max([ctxPeriod.lower ?? period, period])
    if (rateTarget <= rate) ctxPeriod.upper = _.min([ctxPeriod.upper ?? period, period])
  }
  if (ctxPeriod.lower == null) ctxPeriod.target = 2
  else if (ctxPeriod.upper == null) ctxPeriod.target = ctxPeriod.lower
  else if (ctxPeriod.lower === ctxPeriod.upper) ctxPeriod.target = ctxPeriod.lower
  else {
    ctxPeriod.target = Math.trunc(
      ctxPeriod.lower +
      (ctxPeriod.upper - ctxPeriod.lower) *
      (rateTarget - periodMap[ctxPeriod.lower]) /
      (periodMap[ctxPeriod.upper] - periodMap[ctxPeriod.lower]),
    )
  }
  return _.clamp(ctxPeriod.target!, 2, 120)
}

// ─── high-level: full strategy decision ───────────────────────────────
export interface StrategyDecision {
  currency: string
  effectiveRank: number
  targetRate: number       // before clamp
  clampedRate: number      // final rate (after rateMin/rateMax clamp)
  period: number
  amount: number
  totalWeightedVol: bigint
  candleCount: number
}

/**
 * Pure decision function: given config + candle window, return the would-be
 * auto-renew settings. No side effects, no API calls.
 */
export function decideStrategy (
  currency: string,
  cfg1: ConfigCurrency,
  candles: Candle[],
  nowTs: number = Date.now(),
): StrategyDecision | null {
  const validCandles = candles.filter(c => c.volume > 0 && c.high > 0)
  if (validCandles.length === 0) return null

  const ranges = buildRangesBI(validCandles, nowTs, true)
  const totalVol = ranges.reduce((s, r) => s + r.vol, 0n)
  if (ranges.length === 0 || totalVol <= 0n) return null

  const effectiveRank = resolveEffectiveRank(cfg1)
  const rankBI = BigInt(_.round(effectiveRank * 1e8))
  const targetRateBI = binarySearchRateBI(ranges, totalVol, rankBI)
  const targetRate = Number(targetRateBI) / 1e8
  const clampedRate = _.clamp(targetRate, cfg1.rateMin, cfg1.rateMax)
  const period = rateToPeriod(cfg1.period, clampedRate)

  return {
    currency,
    effectiveRank,
    targetRate,
    clampedRate,
    period,
    amount: cfg1.amount,
    totalWeightedVol: totalVol,
    candleCount: validCandles.length,
  }
}
