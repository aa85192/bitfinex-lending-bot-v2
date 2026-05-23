/*
Bitfinex Lending Bot - 即時監控 daemon
持續連線 Bitfinex WSv2 (public + auth),維護記憶體狀態並透過 SSE / Web Push 通知前端。

啟動方式:
  yarn tsx bot/daemon.ts

需要的環境變數: 見 bot/config.ts
*/

import 'dotenv/config'
import { Bitfinex } from '@taichunmin/bitfinex'

import { loadConfig } from './config.js'
import { StateStore, type CurrencyState } from './state.js'
import { PublicSubscriber } from './ws/publicSubscriber.js'
import { AuthSubscriber } from './ws/authSubscriber.js'
import { SubscriptionStore } from './store/subscriptions.js'
import { PushNotifier } from './notify/push.js'
import { EventDispatcher, type NotifyEvent } from './notify/events.js'
import { createServer } from './api/server.js'
import { createLoggersByUrl } from '../lib/logger.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const log = (loggers as any).info as (msg: any) => void
const logErr = (loggers as any).error as (msg: any) => void

async function main (): Promise<void> {
  const cfg = loadConfig()
  log({ msg: 'config loaded', currencies: cfg.currencies, port: cfg.apiPort })

  const state = new StateStore(cfg.currencies)
  const subs = new SubscriptionStore(cfg.dataDir)
  await subs.load()
  log({ msg: 'subscriptions loaded', count: subs.list().length })

  const push = new PushNotifier(subs, {
    publicKey: cfg.vapidPublicKey,
    privateKey: cfg.vapidPrivateKey,
    subject: cfg.vapidSubject,
  })

  const dispatcher = new EventDispatcher(push)

  // REST client for initial snapshot
  const bitfinex = new Bitfinex({
    apiKey: cfg.bitfinexApiKey,
    apiSecret: cfg.bitfinexApiSecret,
    affCode: cfg.bitfinexAffCode,
  })

  // ─── REST snapshot ────────────────────────────────────────────────
  await Promise.all(cfg.currencies.map(cur => loadInitialSnapshot(bitfinex, state, cur)))
  log({ msg: 'initial snapshot loaded' })

  // ─── Public WS ────────────────────────────────────────────────────
  const pub = new PublicSubscriber()
  for (const cur of cfg.currencies) {
    pub.subscribeFundingTrades(cur)
    pub.subscribeFundingTicker(cur)
  }
  pub.on('open', () => log('public ws open'))
  pub.on('close', () => log('public ws closed'))
  pub.on('error', (err) => logErr({ msg: 'public ws error', err: err.message }))

  pub.on('ticker', (t) => {
    const s = state.get(t.currency)
    if (!s) return
    const prevFrr = s.market.frr
    state.patch(t.currency, {
      market: { ...s.market, frr: t.frr },
    })
    if (prevFrr != null && Math.abs(t.frr - prevFrr) / Math.max(prevFrr, 1e-9) >= 0.2) {
      void dispatcher.dispatch({
        kind: 'market.rate_spike',
        currency: t.currency,
        title: `${t.currency} FRR 變動 ${formatPctDelta(prevFrr, t.frr)}`,
        body: `${formatRate(prevFrr)} → ${formatRate(t.frr)} (每日)`,
        data: { prev: prevFrr, next: t.frr },
      })
    }
  })

  pub.on('trade', (trade) => {
    const s = state.get(trade.currency)
    if (!s) return
    state.patch(trade.currency, {
      market: { ...s.market, lastTrade: { rate: trade.rate, amount: Math.abs(trade.amount), period: trade.period, mts: trade.mts } },
    })
    if (Math.abs(trade.amount) >= cfg.largeTradeMinAmount && trade.rate >= cfg.rateAlertThreshold) {
      void dispatcher.dispatch({
        kind: 'market.large_trade',
        currency: trade.currency,
        title: `${trade.currency} 出現可口利率`,
        body: `成交 ${Math.abs(trade.amount).toFixed(0)} @ ${formatRate(trade.rate)}/d × ${trade.period}d`,
        data: { trade },
      })
    }
  })

  pub.connect()

  // ─── Auth WS ──────────────────────────────────────────────────────
  const auth = new AuthSubscriber(cfg.bitfinexApiKey, cfg.bitfinexApiSecret)
  auth.on('open', () => log('auth ws open'))
  auth.on('authed', () => log('auth ws authed'))
  auth.on('close', () => log('auth ws closed'))
  auth.on('error', (err) => logErr({ msg: 'auth ws error', err: err.message }))

  auth.on('wallet', (w) => {
    if (w.type !== 'funding') return
    if (!cfg.currencies.includes(w.currency)) return
    state.patch(w.currency, {
      wallet: {
        balance: w.balance,
        available: w.available ?? state.get(w.currency)?.wallet.available ?? 0,
      },
    })
  })

  auth.on('credit', (c) => {
    if (!cfg.currencies.includes(c.currency)) return
    if (c.kind === 'snapshot') {
      const existing = state.get(c.currency)?.credits ?? []
      state.setCredits(c.currency, [
        ...existing.filter(e => e.id !== c.id),
        { id: c.id, amount: c.amount, rate: c.rate, period: c.period, mtsOpening: c.mtsOpening, mtsLastPayout: c.mtsLastPayout },
      ])
    } else if (c.kind === 'new') {
      state.upsertCredit(c.currency, { id: c.id, amount: c.amount, rate: c.rate, period: c.period, mtsOpening: c.mtsOpening, mtsLastPayout: c.mtsLastPayout })
      void dispatcher.dispatch({
        kind: 'credit.opened',
        currency: c.currency,
        title: `${c.currency} 放款成交`,
        body: `${c.amount.toFixed(2)} @ ${formatRate(c.rate)}/d × ${c.period}d`,
        data: { credit: c },
      })
    } else if (c.kind === 'update') {
      state.upsertCredit(c.currency, { id: c.id, amount: c.amount, rate: c.rate, period: c.period, mtsOpening: c.mtsOpening, mtsLastPayout: c.mtsLastPayout })
    } else if (c.kind === 'close') {
      state.removeCredit(c.currency, c.id)
      void dispatcher.dispatch({
        kind: 'credit.closed',
        currency: c.currency,
        title: `${c.currency} 還款回收`,
        body: `${c.amount.toFixed(2)} @ ${formatRate(c.rate)}/d`,
        data: { credit: c },
      })
    }
  })

  auth.on('offer', (o) => {
    if (!cfg.currencies.includes(o.currency)) return
    if (o.kind === 'snapshot') {
      const existing = state.get(o.currency)?.offers ?? []
      state.setOffers(o.currency, [
        ...existing.filter(e => e.id !== o.id),
        { id: o.id, amount: o.amount, rate: o.rate, period: o.period },
      ])
    } else if (o.kind === 'new' || o.kind === 'update') {
      state.upsertOffer(o.currency, { id: o.id, amount: o.amount, rate: o.rate, period: o.period })
    } else if (o.kind === 'cancel') {
      state.removeOffer(o.currency, o.id)
    }
  })

  auth.connect()

  // ─── Health monitor ───────────────────────────────────────────────
  let lastHealthy = true
  const lastEventAt = { v: Date.now() }
  state.subscribe(() => { lastEventAt.v = Date.now() })

  setInterval(() => {
    const healthy = pub.isHealthy() && auth.isHealthy()
    if (lastHealthy && !healthy) {
      lastHealthy = false
      void dispatcher.dispatch({
        kind: 'bot.unhealthy',
        title: 'Bot 失聯',
        body: `public=${pub.isHealthy()} auth=${auth.isHealthy()}`,
      })
    } else if (!lastHealthy && healthy) {
      lastHealthy = true
      void dispatcher.dispatch({
        kind: 'bot.recovered',
        title: 'Bot 已恢復',
        body: 'WebSocket 連線正常',
      })
    }
  }, 30_000)

  // periodic snapshot refresh as a safety net (RESTful state may diverge from WS)
  setInterval(() => {
    for (const cur of cfg.currencies) {
      loadInitialSnapshot(bitfinex, state, cur).catch(err => logErr({ msg: 'refresh failed', cur, err: err.message }))
    }
  }, 5 * 60_000)

  // ─── HTTP / SSE API ───────────────────────────────────────────────
  const server = createServer({
    state,
    subs,
    push,
    vapidPublicKey: cfg.vapidPublicKey,
    viewerToken: cfg.viewerToken,
    publicOrigin: cfg.publicOrigin,
    health: () => ({ wsPublic: pub.isHealthy(), wsAuth: auth.isHealthy(), lastEventAt: lastEventAt.v }),
    onStateChange: (cb) => state.subscribe(cb),
    onNotifyEvent: (cb) => dispatcher.subscribe(cb),
  })

  server.listen(cfg.apiPort, () => log({ msg: 'api listening', port: cfg.apiPort }))

  // ─── Graceful shutdown ────────────────────────────────────────────
  const shutdown = () => {
    log('shutting down')
    pub.close()
    auth.close()
    server.close()
    setTimeout(() => process.exit(0), 1000)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

async function loadInitialSnapshot (bitfinex: any, state: StateStore, currency: string): Promise<void> {
  try {
    const [wallets, credits, offers] = await Promise.all([
      bitfinex.v2AuthReadWallets(),
      bitfinex.v2AuthReadFundingCredits({ currency }),
      bitfinex.v2AuthReadFundingOffers({ currency }),
    ])
    const fundingWallet = (wallets as any[]).find(w => w.type === 'funding' && w.currency === currency)
    state.patch(currency, {
      wallet: {
        balance: fundingWallet?.balance ?? 0,
        available: fundingWallet?.availableBalance ?? fundingWallet?.balance ?? 0,
      },
      credits: (credits as any[])
        .filter(c => c.side === 1)
        .map(c => ({
          id: c.id,
          amount: Math.abs(c.amount),
          rate: c.rate,
          period: c.period,
          mtsOpening: c.mtsOpening instanceof Date ? c.mtsOpening.getTime() : Number(c.mtsOpening),
          mtsLastPayout: c.mtsLastPayout
            ? (c.mtsLastPayout instanceof Date ? c.mtsLastPayout.getTime() : Number(c.mtsLastPayout))
            : null,
        })),
      offers: (offers as any[]).map(o => ({
        id: o.id,
        amount: Math.abs(o.amount),
        rate: o.rate,
        period: o.period,
      })),
    })
  } catch (err: any) {
    logErr({ msg: 'snapshot failed', currency, err: err?.message })
  }
}

function formatRate (rate: number): string {
  return `${(rate * 100).toFixed(4)}%`
}

function formatPctDelta (prev: number, next: number): string {
  if (prev === 0) return ''
  const pct = ((next - prev) / prev) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

main().catch(err => {
  console.error('fatal', err)
  process.exit(1)
})
