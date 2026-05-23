import http from 'node:http'
import { URL } from 'node:url'
import { StateStore, CurrencyState } from '../state.js'
import { SubscriptionStore } from '../store/subscriptions.js'
import { PushNotifier } from '../notify/push.js'
import { NotifyEvent } from '../notify/events.js'

const MAX_BODY_BYTES = 16 * 1024

interface ServerDeps {
  state: StateStore
  subs: SubscriptionStore
  push: PushNotifier
  vapidPublicKey: string
  viewerToken: string
  publicOrigin: string
  health: () => { wsPublic: boolean, wsAuth: boolean, lastEventAt: number, strategyMode?: string }
  onNotifyEvent: (cb: (e: NotifyEvent) => void) => () => void
  onStateChange: (cb: (currency: string, state: CurrencyState) => void) => () => void
}

interface SseClient {
  res: http.ServerResponse
  filter: string | null
}

export function createServer (deps: ServerDeps): http.Server {
  const sseClients = new Set<SseClient>()
  const corsOrigin = deps.publicOrigin

  const unsubscribeState = deps.onStateChange((currency, state) => {
    broadcast(sseClients, 'state', { currency, state }, c => c.filter === null || c.filter === currency)
  })
  const unsubscribeEvent = deps.onNotifyEvent((event) => {
    broadcast(sseClients, 'event', event, c => c.filter === null || c.filter === event.currency)
  })

  const server = http.createServer(async (req, res) => {
    if (!req.url) { res.statusCode = 400; res.end('bad request'); return }

    setCors(res, corsOrigin)
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

    const reqUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const route = `${req.method} ${reqUrl.pathname}`

    try {
      if (route === 'GET /api/health') {
        return json(res, 200, { ok: true, ...deps.health() })
      }

      if (route === 'GET /api/config') {
        return json(res, 200, {
          vapidPublicKey: deps.vapidPublicKey,
          currencies: deps.state.all().map(s => s.currency),
          authRequired: Boolean(deps.viewerToken),
        })
      }

      if (!checkAuth(req, deps.viewerToken)) {
        return json(res, 401, { error: 'unauthorized' })
      }

      if (route === 'GET /api/status') {
        return json(res, 200, { currencies: deps.state.all() })
      }

      const statusMatch = reqUrl.pathname.match(/^\/api\/status\/([A-Za-z0-9]+)$/)
      if (req.method === 'GET' && statusMatch) {
        const cur = statusMatch[1].toUpperCase()
        const s = deps.state.get(cur)
        if (!s) return json(res, 404, { error: 'unknown currency' })
        return json(res, 200, s)
      }

      if (route === 'GET /api/stream') {
        return openSse(req, res, reqUrl, deps, sseClients)
      }

      if (route === 'POST /api/push/subscribe') {
        const body = await readBody(req)
        const sub = body?.subscription
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return json(res, 400, { error: 'invalid subscription' })
        }
        deps.subs.add({
          endpoint: sub.endpoint,
          expirationTime: sub.expirationTime ?? null,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          ua: typeof body?.ua === 'string' ? body.ua.slice(0, 200) : undefined,
        })
        return json(res, 200, { ok: true, total: deps.subs.list().length })
      }

      if (route === 'POST /api/push/unsubscribe') {
        const body = await readBody(req)
        const endpoint = body?.endpoint
        if (typeof endpoint !== 'string') return json(res, 400, { error: 'missing endpoint' })
        const removed = deps.subs.remove(endpoint)
        return json(res, 200, { removed })
      }

      if (route === 'POST /api/push/test') {
        const { sent, removed } = await deps.push.sendToAll({
          title: 'Bitfinex Bot 測試通知',
          body: '推播訂閱正常運作 ✓',
          tag: 'test',
        })
        return json(res, 200, { sent, removed })
      }

      return json(res, 404, { error: 'not found' })
    } catch (err: any) {
      return json(res, 500, { error: err?.message ?? 'internal' })
    }
  })

  server.on('close', () => {
    unsubscribeState()
    unsubscribeEvent()
    for (const c of sseClients) try { c.res.end() } catch { /* noop */ }
    sseClients.clear()
  })

  return server
}

function setCors (res: http.ServerResponse, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '600')
}

function json (res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function checkAuth (req: http.IncomingMessage, viewerToken: string): boolean {
  if (!viewerToken) return true
  const provided = (() => {
    const h = req.headers.authorization
    if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x'}`)
    return u.searchParams.get('token') ?? ''
  })()
  if (!provided || provided.length !== viewerToken.length) return false
  // constant-time compare
  let mismatch = 0
  for (let i = 0; i < viewerToken.length; i++) mismatch |= provided.charCodeAt(i) ^ viewerToken.charCodeAt(i)
  return mismatch === 0
}

async function readBody (req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function openSse (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  deps: ServerDeps,
  clients: Set<SseClient>,
) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const filter = reqUrl.searchParams.get('currency')?.toUpperCase() ?? null
  const client: SseClient = { res, filter }
  clients.add(client)

  // initial snapshot
  for (const s of deps.state.all()) {
    if (filter && s.currency !== filter) continue
    writeSse(res, 'state', { currency: s.currency, state: s })
  }
  writeSse(res, 'health', deps.health())

  const heartbeat = setInterval(() => {
    try { res.write(':\n\n') } catch { /* noop */ }
  }, 25_000)

  const cleanup = () => {
    clearInterval(heartbeat)
    clients.delete(client)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

function broadcast<T> (
  clients: Set<SseClient>,
  event: string,
  data: T,
  filter: (c: SseClient) => boolean,
) {
  for (const c of clients) {
    if (!filter(c)) continue
    try { writeSse(c.res, event, data) } catch { /* connection dead, will be cleaned up */ }
  }
}

function writeSse (res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
