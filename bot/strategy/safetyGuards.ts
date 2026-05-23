/**
 * Safety guards for reactive trading. Every decision passes through
 * `evaluate()` to determine if it's safe to execute. Blocks include:
 *
 *   - warmup period after start / WS reconnect (state may be stale)
 *   - min interval between writes per currency (rate-limit + sanity)
 *   - min relative rate change vs current setting (avoid quote-thrashing)
 *   - daily write budget per currency (hard ceiling)
 *
 * State is in-memory; resets on daemon restart, which is acceptable.
 */

export interface GuardConfig {
  warmupMs: number
  minIntervalMs: number
  minRateChangePct: number       // e.g. 1 = require ≥1% relative move
  dailyBudget: number            // max writes per currency per 24h
  minAmountToTrade: number       // skip if amount === 0 (wallet empty)
}

export interface CurrentSettings {
  rate: number    // absolute daily rate
  period: number
  amount: number
}

export type GuardResult =
  | { allow: true }
  | { allow: false, reason: string, retryHintMs?: number }

interface CurrencyState {
  lastTradeAt: number
  windowStart: number
  windowCount: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export class SafetyGuards {
  private readyAt: number
  private state = new Map<string, CurrencyState>()

  constructor (private cfg: GuardConfig, now: number = Date.now()) {
    this.readyAt = now + cfg.warmupMs
  }

  /** Reset warmup after WS reconnect — local state may be stale. */
  markStateStale (now: number = Date.now()): void {
    this.readyAt = Math.max(this.readyAt, now + this.cfg.warmupMs)
  }

  evaluate (params: {
    currency: string
    next: CurrentSettings
    current: CurrentSettings | null
    walletAvailable: number
    now?: number
  }): GuardResult {
    const now = params.now ?? Date.now()

    if (now < this.readyAt) {
      return { allow: false, reason: `warmup (${Math.ceil((this.readyAt - now) / 1000)}s left)`, retryHintMs: this.readyAt - now }
    }

    const s = this.state.get(params.currency)
    if (s && (now - s.lastTradeAt) < this.cfg.minIntervalMs) {
      const wait = this.cfg.minIntervalMs - (now - s.lastTradeAt)
      return { allow: false, reason: `min interval (${Math.ceil(wait / 1000)}s left)`, retryHintMs: wait }
    }

    if (params.next.amount <= 0 && params.walletAvailable < this.cfg.minAmountToTrade) {
      // Nothing to deploy
      return { allow: false, reason: 'no available balance' }
    }

    if (params.current) {
      const sameSettings =
        approxEqual(params.current.rate, params.next.rate, this.cfg.minRateChangePct) &&
        params.current.period === params.next.period &&
        approxEqual(params.current.amount, params.next.amount, 1)
      if (sameSettings && params.walletAvailable < this.cfg.minAmountToTrade) {
        return { allow: false, reason: 'no meaningful change' }
      }
    }

    // budget check
    const budgetState = s ?? { lastTradeAt: 0, windowStart: now, windowCount: 0 }
    const windowAge = now - budgetState.windowStart
    const effectiveCount = windowAge >= DAY_MS ? 0 : budgetState.windowCount
    if (effectiveCount >= this.cfg.dailyBudget) {
      return { allow: false, reason: `daily budget reached (${effectiveCount}/${this.cfg.dailyBudget})` }
    }

    return { allow: true }
  }

  /** Call after a successful trade. */
  recordTrade (currency: string, now: number = Date.now()): void {
    const prev = this.state.get(currency)
    const windowExpired = !prev || (now - prev.windowStart) >= DAY_MS
    this.state.set(currency, {
      lastTradeAt: now,
      windowStart: windowExpired ? now : prev!.windowStart,
      windowCount: (windowExpired ? 0 : prev!.windowCount) + 1,
    })
  }

  stats (): Record<string, { lastTradeAt: number, count: number, windowStart: number }> {
    return Object.fromEntries(
      [...this.state.entries()].map(([cur, s]) => [cur, {
        lastTradeAt: s.lastTradeAt,
        count: s.windowCount,
        windowStart: s.windowStart,
      }]),
    )
  }
}

function approxEqual (a: number, b: number, tolerancePct: number): boolean {
  const tolerance = tolerancePct / 100
  if (a === b) return true
  const denom = Math.max(Math.abs(a), Math.abs(b))
  if (denom === 0) return Math.abs(a - b) < 1e-9
  return Math.abs(a - b) / denom < tolerance
}
