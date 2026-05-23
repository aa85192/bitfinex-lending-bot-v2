import { PushNotifier, PushPayload } from './push.js'

export type EventKind =
  | 'credit.opened'
  | 'credit.closed'
  | 'offer.placed'
  | 'offer.cancelled'
  | 'market.large_trade'
  | 'market.rate_spike'
  | 'bot.unhealthy'
  | 'bot.recovered'

export interface NotifyEvent {
  kind: EventKind
  currency?: string
  title: string
  body: string
  data?: Record<string, unknown>
}

interface CooldownEntry { lastSent: number, count: number }

/**
 * Throttles notification dispatch and exposes a unified entry point.
 * Per-kind cooldown prevents flapping events from spamming push notifications.
 */
export class EventDispatcher {
  private cooldowns = new Map<string, CooldownEntry>()
  private listeners = new Set<(e: NotifyEvent) => void>()

  constructor (
    private push: PushNotifier,
    private cooldownMs: Record<EventKind, number> = {
      'credit.opened': 0,
      'credit.closed': 0,
      'offer.placed': 0,
      'offer.cancelled': 0,
      'market.large_trade': 30_000,
      'market.rate_spike': 60_000,
      'bot.unhealthy': 5 * 60_000,
      'bot.recovered': 0,
    },
  ) {}

  subscribe (listener: (e: NotifyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispatch (event: NotifyEvent): Promise<void> {
    const key = `${event.kind}:${event.currency ?? '_'}`
    const cd = this.cooldownMs[event.kind] ?? 0
    const entry = this.cooldowns.get(key)
    const now = Date.now()
    if (cd > 0 && entry && (now - entry.lastSent) < cd) {
      entry.count++
      return
    }
    this.cooldowns.set(key, { lastSent: now, count: 1 })

    for (const l of this.listeners) {
      try { l(event) } catch { /* noop */ }
    }

    const payload: PushPayload = {
      title: event.title,
      body: event.body,
      tag: event.kind,
      data: event.data,
    }
    await this.push.sendToAll(payload).catch(() => { /* logged elsewhere */ })
  }
}
