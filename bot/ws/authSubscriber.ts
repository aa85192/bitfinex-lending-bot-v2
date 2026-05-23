import WebSocket from 'ws'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const AUTH_WS_URL = 'wss://api.bitfinex.com/ws/2'
const PING_INTERVAL_MS = 15_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000

export interface WalletUpdate {
  type: string
  currency: string
  balance: number
  available: number | null
}

export interface FundingCreditUpdate {
  kind: 'snapshot' | 'new' | 'update' | 'close'
  id: number
  symbol: string
  currency: string
  amount: number
  rate: number
  period: number
  mtsOpening: number
  mtsLastPayout: number | null
  status: string
}

export interface FundingOfferUpdate {
  kind: 'snapshot' | 'new' | 'update' | 'cancel'
  id: number
  symbol: string
  currency: string
  amount: number
  rate: number
  period: number
  status: string
}

interface AuthEvents {
  open: []
  authed: []
  close: []
  wallet: [WalletUpdate]
  credit: [FundingCreditUpdate]
  offer: [FundingOfferUpdate]
  notification: [any]
  error: [Error]
}

function parseSymbolCurrency (symbol: string): string {
  // 'fUSD' -> 'USD'
  if (typeof symbol === 'string' && symbol.startsWith('f')) return symbol.slice(1).toUpperCase()
  return symbol
}

export class AuthSubscriber extends EventEmitter {
  private ws: WebSocket | null = null
  private apiKey: string
  private apiSecret: string
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private closed = false
  private lastMessageAt = Date.now()
  private authed = false

  constructor (apiKey: string, apiSecret: string) {
    super()
    this.apiKey = apiKey
    this.apiSecret = apiSecret
  }

  on<E extends keyof AuthEvents> (event: E, listener: (...args: AuthEvents[E]) => void): this {
    return super.on(event, listener as any)
  }

  emit<E extends keyof AuthEvents> (event: E, ...args: AuthEvents[E]): boolean {
    return super.emit(event, ...args)
  }

  connect (): void {
    if (this.closed) return
    this.cleanupSocket()
    const ws = new WebSocket(AUTH_WS_URL)
    this.ws = ws
    this.authed = false

    ws.on('open', () => {
      this.reconnectAttempts = 0
      this.lastMessageAt = Date.now()
      this.emit('open')
      this.sendAuth()
      this.startPing()
    })

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      try { this.handleMessage(JSON.parse(raw.toString())) } catch (err) {
        this.emit('error', new Error(`auth parse: ${(err as Error).message}`))
      }
    })

    ws.on('close', () => {
      this.authed = false
      this.emit('close')
      this.stopPing()
      if (!this.closed) this.scheduleReconnect()
    })

    ws.on('error', (err) => this.emit('error', err))
  }

  close (): void {
    this.closed = true
    this.cleanupSocket()
    this.stopPing()
  }

  isHealthy (): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN && (Date.now() - this.lastMessageAt) < 60_000
  }

  private cleanupSocket () {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close() } catch { /* noop */ }
      this.ws = null
    }
  }

  private sendAuth () {
    const nonce = (Date.now() * 1000).toString()
    const authPayload = `AUTH${nonce}`
    const authSig = crypto.createHmac('sha384', this.apiSecret).update(authPayload).digest('hex')
    this.ws?.send(JSON.stringify({
      event: 'auth',
      apiKey: this.apiKey,
      authSig,
      authPayload,
      authNonce: nonce,
      filter: ['funding', 'wallet', 'notify'],
    }))
  }

  private startPing () {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 45_000) {
        this.emit('error', new Error('auth ws stale, reconnecting'))
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
    if (!Array.isArray(msg)) {
      if (msg.event === 'auth') {
        if (msg.status === 'OK') {
          this.authed = true
          this.emit('authed')
        } else {
          this.emit('error', new Error(`auth failed: ${msg.msg ?? JSON.stringify(msg)}`))
        }
        return
      }
      if (msg.event === 'error') {
        this.emit('error', new Error(`bitfinex: ${msg.msg ?? JSON.stringify(msg)}`))
      }
      return
    }

    const [, type, payload] = msg
    if (type === 'hb') return

    switch (type) {
      case 'ws':
      case 'wu':
        this.handleWallet(type, payload)
        break
      case 'fcs':
        if (Array.isArray(payload)) for (const c of payload) this.handleCredit('snapshot', c)
        break
      case 'fcn': this.handleCredit('new', payload); break
      case 'fcu': this.handleCredit('update', payload); break
      case 'fcc': this.handleCredit('close', payload); break
      case 'fos':
        if (Array.isArray(payload)) for (const o of payload) this.handleOffer('snapshot', o)
        break
      case 'fon': this.handleOffer('new', payload); break
      case 'fou': this.handleOffer('update', payload); break
      case 'foc': this.handleOffer('cancel', payload); break
      case 'n':
        this.emit('notification', payload)
        break
      default:
        // ignore: fls/fln/flu/flc (loans, we don't borrow), fte/ftu (own trades), etc.
        break
    }
  }

  private handleWallet (type: string, payload: any) {
    if (type === 'ws' && Array.isArray(payload)) {
      for (const w of payload) this.emitWallet(w)
    } else if (Array.isArray(payload)) {
      this.emitWallet(payload)
    }
  }

  private emitWallet (arr: any[]) {
    // [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE, ...]
    const [type, currency, balance, , available] = arr
    if (!type || !currency) return
    this.emit('wallet', {
      type: String(type),
      currency: String(currency).toUpperCase(),
      balance: Number(balance),
      available: available == null ? null : Number(available),
    })
  }

  private handleCredit (kind: FundingCreditUpdate['kind'], arr: any) {
    if (!Array.isArray(arr)) return
    // [ID, SYMBOL, SIDE, MTS_CREATE, MTS_UPDATE, AMOUNT, FLAGS, STATUS, RATE_TYPE, -, -, RATE, PERIOD, MTS_OPENING, MTS_LAST_PAYOUT, ...]
    this.emit('credit', {
      kind,
      id: Number(arr[0]),
      symbol: String(arr[1] ?? ''),
      currency: parseSymbolCurrency(String(arr[1] ?? '')),
      amount: Math.abs(Number(arr[5] ?? 0)),
      rate: Number(arr[11] ?? 0),
      period: Number(arr[12] ?? 0),
      mtsOpening: Number(arr[13] ?? 0),
      mtsLastPayout: arr[14] ? Number(arr[14]) : null,
      status: String(arr[7] ?? ''),
    })
  }

  private handleOffer (kind: FundingOfferUpdate['kind'], arr: any) {
    if (!Array.isArray(arr)) return
    // [ID, SYMBOL, MTS_CREATE, MTS_UPDATE, AMOUNT, AMOUNT_ORIG, TYPE, -, -, FLAGS, STATUS, -, -, -, RATE, PERIOD, ...]
    this.emit('offer', {
      kind,
      id: Number(arr[0]),
      symbol: String(arr[1] ?? ''),
      currency: parseSymbolCurrency(String(arr[1] ?? '')),
      amount: Math.abs(Number(arr[4] ?? 0)),
      rate: Number(arr[14] ?? 0),
      period: Number(arr[15] ?? 0),
      status: String(arr[10] ?? ''),
    })
  }
}
