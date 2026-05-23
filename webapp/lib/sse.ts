'use client'

import { useEffect, useRef, useState } from 'react'
import { type RuntimeConfig, withAuthQuery } from './config'

export interface BotHealth {
  wsPublic: boolean
  wsAuth: boolean
  lastEventAt: number
}

export interface ServerEvent {
  kind: string
  currency?: string
  title: string
  body: string
  data?: Record<string, unknown>
  receivedAt: number
}

export interface LiveStatePayload<T = any> {
  currency: string
  state: T
}

interface UseLiveStreamOpts<T> {
  cfg: RuntimeConfig | null
  currency?: string
  onState?: (payload: LiveStatePayload<T>) => void
  onEvent?: (event: ServerEvent) => void
}

export function useLiveStream<T = any> (opts: UseLiveStreamOpts<T>) {
  const { cfg, currency, onState, onEvent } = opts
  const [connected, setConnected] = useState(false)
  const [health, setHealth] = useState<BotHealth | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const onStateRef = useRef(onState)
  const onEventRef = useRef(onEvent)

  useEffect(() => { onStateRef.current = onState }, [onState])
  useEffect(() => { onEventRef.current = onEvent }, [onEvent])

  useEffect(() => {
    if (!cfg?.apiBase) return
    const params = new URLSearchParams()
    if (currency) params.set('currency', currency)
    const baseUrl = `${cfg.apiBase}/api/stream${params.toString() ? '?' + params : ''}`
    const url = withAuthQuery(baseUrl, cfg)

    let es: EventSource | null = null
    let cancelled = false
    let retryTimer: number | null = null
    let retryDelay = 2000

    const open = () => {
      if (cancelled) return
      try {
        es = new EventSource(url)
      } catch (err: any) {
        setLastError(err?.message ?? 'EventSource init failed')
        scheduleRetry()
        return
      }

      es.addEventListener('open', () => {
        setConnected(true)
        setLastError(null)
        retryDelay = 2000
      })

      es.addEventListener('state', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as LiveStatePayload<T>
          onStateRef.current?.(payload)
        } catch { /* ignore */ }
      })

      es.addEventListener('event', (ev) => {
        try {
          const evt = JSON.parse((ev as MessageEvent).data)
          onEventRef.current?.({ ...evt, receivedAt: Date.now() })
        } catch { /* ignore */ }
      })

      es.addEventListener('health', (ev) => {
        try { setHealth(JSON.parse((ev as MessageEvent).data) as BotHealth) } catch { /* ignore */ }
      })

      es.addEventListener('error', () => {
        setConnected(false)
        try { es?.close() } catch { /* noop */ }
        scheduleRetry()
      })
    }

    const scheduleRetry = () => {
      if (cancelled) return
      retryTimer = window.setTimeout(open, retryDelay)
      retryDelay = Math.min(retryDelay * 1.8, 30_000)
    }

    open()

    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
      try { es?.close() } catch { /* noop */ }
      setConnected(false)
    }
  }, [cfg?.apiBase, cfg?.viewerToken, currency])

  return { connected, health, lastError }
}
