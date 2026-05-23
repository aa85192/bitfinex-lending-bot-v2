import _ from 'lodash'
import {
  decideStrategy,
  type StrategyConfig,
  type StrategyDecision,
} from './rateCalculator.js'
import { CandleBuffer } from './candleBuffer.js'
import { SafetyGuards, type CurrentSettings, type GuardResult } from './safetyGuards.js'
import { RestExecutor } from '../rest/executor.js'
import type { StateStore } from '../state.js'

export type StrategyMode = 'off' | 'dry_run' | 'live'

export interface EngineEvent {
  kind: 'decision' | 'executed' | 'skipped' | 'error'
  currency: string
  mode: StrategyMode
  decision?: StrategyDecision
  current?: CurrentSettings | null
  reason?: string
  error?: string
}

interface EngineDeps {
  mode: StrategyMode
  config: StrategyConfig
  state: StateStore
  candles: CandleBuffer
  guards: SafetyGuards
  executor: RestExecutor
  debounceMs: number
  onEvent: (event: EngineEvent) => void
  log: (msg: any) => void
  logErr: (msg: any) => void
}

/**
 * The reactive engine. WS event handlers call `trigger(currency)`. The engine
 * debounces, then computes the strategy decision against the current candle
 * buffer + account state. If guards allow and mode='live', it executes.
 * In 'dry_run' it logs the intended action. In 'off' the engine does nothing.
 */
export class ReactiveEngine {
  private debounced = new Map<string, () => void>()
  private currentAutoRenew = new Map<string, CurrentSettings | null>()

  constructor (private deps: EngineDeps) {
    for (const cur of Object.keys(deps.config)) {
      this.debounced.set(cur, _.debounce(
        () => { void this.evaluate(cur) },
        deps.debounceMs,
        { leading: false, trailing: true, maxWait: deps.debounceMs * 5 },
      ))
    }
  }

  /** Schedule a debounced evaluation for `currency`. */
  trigger (currency: string): void {
    if (this.deps.mode === 'off') return
    const fn = this.debounced.get(currency)
    if (fn) fn()
  }

  /** Force-flush any pending evaluation (e.g. on graceful shutdown for tests). */
  async evaluateAll (): Promise<void> {
    for (const cur of Object.keys(this.deps.config)) await this.evaluate(cur)
  }

  /**
   * One-shot REST refresh of current auto-renew status. Called periodically
   * from daemon to keep `currentAutoRenew` in sync (the auth WS does not
   * emit auto-renew status changes).
   */
  async refreshCurrent (currency: string): Promise<void> {
    try {
      const status = await this.deps.executor.readAutoFundingStatus(currency)
      if (status == null) {
        this.currentAutoRenew.set(currency, null)
      } else {
        this.currentAutoRenew.set(currency, {
          rate: Number(status.rate ?? 0),
          period: Number(status.period ?? 0),
          amount: Number(status.amount ?? 0),
        })
      }
    } catch (err: any) {
      this.deps.logErr({ msg: 'refreshCurrent failed', currency, err: err?.message })
    }
  }

  private async evaluate (currency: string): Promise<void> {
    if (this.deps.mode === 'off') return
    const cfg1 = this.deps.config[currency]
    if (!cfg1) return

    const candles = this.deps.candles.get(currency)
    if (candles.length === 0) {
      this.deps.log({ msg: 'engine skip: no candles yet', currency })
      return
    }

    const decision = decideStrategy(currency, cfg1, candles)
    if (!decision) {
      this.deps.log({ msg: 'engine skip: no usable candle data', currency })
      return
    }

    const accountState = this.deps.state.get(currency)
    const walletAvailable = accountState?.wallet.available ?? 0
    const current = this.currentAutoRenew.get(currency) ?? null

    const next: CurrentSettings = {
      rate: decision.clampedRate,
      period: decision.period,
      amount: decision.amount,
    }

    this.deps.onEvent({
      kind: 'decision',
      currency,
      mode: this.deps.mode,
      decision,
      current,
    })

    const guard: GuardResult = this.deps.guards.evaluate({
      currency,
      next,
      current,
      walletAvailable,
    })

    if (!guard.allow) {
      const reason = (guard as { allow: false, reason: string }).reason
      this.deps.onEvent({
        kind: 'skipped',
        currency,
        mode: this.deps.mode,
        decision,
        current,
        reason,
      })
      return
    }

    if (this.deps.mode === 'dry_run') {
      this.deps.log({
        msg: 'DRY_RUN would apply',
        currency,
        from: current,
        to: next,
      })
      this.deps.onEvent({
        kind: 'executed',
        currency,
        mode: 'dry_run',
        decision,
        current,
      })
      return
    }

    // live mode
    try {
      await this.deps.executor.applyAutoFunding({
        currency,
        amount: next.amount,
        period: next.period,
        rate: next.rate,
        deactivateFirst: current != null,
        cancelOffers: current != null,
      })
      this.deps.guards.recordTrade(currency)
      this.currentAutoRenew.set(currency, next)
      this.deps.onEvent({
        kind: 'executed',
        currency,
        mode: 'live',
        decision,
        current,
      })
    } catch (err: any) {
      this.deps.onEvent({
        kind: 'error',
        currency,
        mode: 'live',
        decision,
        current,
        error: err?.message ?? String(err),
      })
      this.deps.logErr({ msg: 'engine execute failed', currency, err: err?.message })
    }
  }
}
