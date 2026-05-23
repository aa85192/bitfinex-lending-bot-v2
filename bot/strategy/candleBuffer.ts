import { Bitfinex, BitfinexSort } from '@taichunmin/bitfinex'
import type { Candle } from './rateCalculator.js'
import { WINDOW_MS } from './rateCalculator.js'

/**
 * Maintains a rolling 24h buffer of 1-minute funding candles per currency.
 *
 * Refresh strategy: REST-pulled (not WS) — Bitfinex's funding candle WS key
 * format requires the same aggregation/period params as REST and has its own
 * subscription quirks. A 60s REST refresh is plenty given that the candle
 * buffer changes slowly and we still react in real time to WS trade events.
 *
 * The buffer mirrors the cron's `v2CandlesHist({ aggregation: 30, periodEnd: 30,
 * periodStart: 2, timeframe: '1m', start, end })` call.
 */
export class CandleBuffer {
  private buffers = new Map<string, Candle[]>()
  private lastRefreshAt = new Map<string, number>()
  private inflight = new Map<string, Promise<void>>()

  constructor (private currencies: string[]) {}

  get (currency: string): Candle[] {
    return this.buffers.get(currency) ?? []
  }

  lastRefresh (currency: string): number | null {
    return this.lastRefreshAt.get(currency) ?? null
  }

  /** Trigger a refresh; concurrent calls dedup to a single in-flight request. */
  async refresh (currency: string, now: number = Date.now()): Promise<void> {
    const existing = this.inflight.get(currency)
    if (existing) return existing
    const p = (async () => {
      try {
        const windowStart = new Date(now - WINDOW_MS)
        const windowEnd = new Date(now)
        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 10000,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          start: windowStart,
          end: windowEnd,
          timeframe: '1m',
        })
        this.buffers.set(currency, candles as Candle[])
        this.lastRefreshAt.set(currency, Date.now())
      } finally {
        this.inflight.delete(currency)
      }
    })()
    this.inflight.set(currency, p)
    return p
  }

  async refreshAll (): Promise<void> {
    await Promise.all(this.currencies.map(c => this.refresh(c).catch(() => { /* logged elsewhere */ })))
  }

  /** Start a periodic refresh timer. Returns the timer for clearing. */
  startAutoRefresh (intervalMs: number): NodeJS.Timeout {
    return setInterval(() => { void this.refreshAll() }, intervalMs)
  }
}
