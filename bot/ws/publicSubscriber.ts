import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

const PUBLIC_WS_URL = 'wss://api-pub.bitfinex.com/ws/2'
const PING_INTERVAL_MS = 15_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000

export interface FundingTradeEvent {
  currency: string
  id: number
  mts: number
  amount: number
  rate: number
  period: number
}

export interface FundingTickerEvent {
  currency: string
  frr: number
  bid: number
  bidPeriod: number
  bidSize: number
  ask: number
  askPeriod: number
  askSize: number
  dailyChange: number
  dailyChangePerc: number
  lastPrice: number
  volume: number
  high: number
  low: number
  frrAmountAvailable: number | null
}

type Subscription =
  | { kind: 'trades', currency: string }
  | { kind: 'ticker', currency: string }

interface PublicEvents {
  open: []
  close: []
  trade: [FundingTradeEvent]
  ticker: [FundingTickerEvent]
  error: [Error]
}

export class PublicSubscriber extends EventEmitter {
  private ws: WebSocket | null = null
  private subscriptions: Subscription[] = []
  private chanMap = new Map<number, Subscription>()
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private closed = false
  private lastMessageAt = Date.now()

  on<E extends keyof PublicEvents> (event: E, listener: (...args: PublicEvents[E]) => void): this {
    return super.on(event, listener as any)
  }

  emit<E extends keyof PublicEvents> (event: E, ...args: PublicEvents[E]): boolean {
    return super.emit(event, ...args)
  }

  subscribeFundingTrades (currency: string): void {
    this.subscriptions.push({ kind: 'trades', currency })
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe({ kind: 'trades', currency })
  }

  subscribeFundingTicker (currency: string): void {
    this.subscriptions.push({ kind: 'ticker', currency })
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe({ kind: 'ticker', currency })
  }

  connect (): void {
    if (this.closed) return
    this.cleanupSocket()
    this.chanMap.clear()
    const ws = new WebSocket(PUBLIC_WS_URL)
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempts = 0
      this.lastMessageAt = Date.now()
      this.emit('open')
      for (const sub of this.subscriptions) this.sendSubscribe(sub)
      this.startPing()
    })

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      try { this.handleMessage(JSON.parse(raw.toString())) } catch (err) {
        this.emit('error', new Error(`parse: ${(err as Error).message}`))
      }
    })

    ws.on('close', () => {
      this.emit('close')
      this.stopPing()
      if (!this.closed) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  close (): void {
    this.closed = true
    this.cleanupSocket()
    this.stopPing()
  }

  isHealthy (): boolean {
    return this.ws?.readyState === WebSocket.OPEN && (Date.now() - this.lastMessageAt) < 60_000
  }

  private cleanupSocket () {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close() } catch { /* noop */ }
      this.ws = null
    }
  }

  private sendSubscribe (sub: Subscription) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const symbol = `f${sub.currency}`
    if (sub.kind === 'trades') {
      this.ws.send(JSON.stringify({ event: 'subscribe', channel: 'trades', symbol }))
    } else if (sub.kind === 'ticker') {
      this.ws.send(JSON.stringify({ event: 'subscribe', channel: 'ticker', symbol }))
    }
  }

  private startPing () {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 45_000) {
        this.emit('error', new Error('public ws stale, reconnecting'))
        this.cleanupSocket()
        this.scheduleReconnect()
        return
      }
      try { this.ws?.ping() } catch { /* noop */ }
    }, PING_INTERVAL_MS)
  }

  private stopPing () {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
  }

  private scheduleReconnect () {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts))
    this.reconnectAttempts++
    setTimeout(() => this.connect(), delay)
  }

  private handleMessage (msg: any) {
    if (Array.isArray(msg)) {
      const [chanId, type, payload] = msg
      const sub = this.chanMap.get(chanId)
      if (!sub) return
      if (type === 'hb') return

      if (sub.kind === 'trades') {
        // Snapshot: [[id, mts, amount, rate, period], ...]
        // Update:   'fte' or 'ftu', [id, mts, amount, rate, period]
        if (Array.isArray(type)) {
          for (const t of type) this.emitTrade(sub.currency, t)
        } else if (type === 'fte' && Array.isArray(payload)) {
          this.emitTrade(sub.currency, payload)
        }
      } else if (sub.kind === 'ticker') {
        // Snapshot or update: array of values
        const arr = Array.isArray(type) ? type : Array.isArray(payload) ? payload : null
        if (arr && arr.length >= 16) this.emitTicker(sub.currency, arr)
      }
      return
    }

    if (msg.event === 'subscribed') {
      const sub = this.subscriptions.find(s => {
        const symMatch = msg.symbol === `f${s.currency}`
        if (s.kind === 'trades') return msg.channel === 'trades' && symMatch
        if (s.kind === 'ticker') return msg.channel === 'ticker' && symMatch
        return false
      })
      if (sub) this.chanMap.set(msg.chanId, sub)
      return
    }

    if (msg.event === 'error') {
      this.emit('error', new Error(`bitfinex: ${msg.msg ?? JSON.stringify(msg)}`))
    }
  }

  private emitTrade (currency: string, arr: any[]) {
    const [id, mts, amount, rate, period] = arr
    this.emit('trade', {
      currency,
      id: Number(id),
      mts: Number(mts),
      amount: Number(amount),
      rate: Number(rate),
      period: Number(period),
    })
  }

  private emitTicker (currency: string, arr: any[]) {
    this.emit('ticker', {
      currency,
      frr: Number(arr[0]),
      bid: Number(arr[1]),
      bidPeriod: Number(arr[2]),
      bidSize: Number(arr[3]),
      ask: Number(arr[4]),
      askPeriod: Number(arr[5]),
      askSize: Number(arr[6]),
      dailyChange: Number(arr[7]),
      dailyChangePerc: Number(arr[8]),
      lastPrice: Number(arr[9]),
      volume: Number(arr[10]),
      high: Number(arr[11]),
      low: Number(arr[12]),
      frrAmountAvailable: arr.length > 15 ? Number(arr[15]) : null,
    })
  }
}
