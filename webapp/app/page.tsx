'use client'

import { useEffect, useState, useCallback } from 'react'
import CurrencyTabs from '@/components/CurrencyTabs'
import MetricCard from '@/components/MetricCard'
import AutoRenewCard from '@/components/AutoRenewCard'
import CreditsTable from '@/components/CreditsTable'
import LendingCharts from '@/components/LendingCharts'
import LiveBadge from '@/components/LiveBadge'
import NotificationButton from '@/components/NotificationButton'
import SetupPanel from '@/components/SetupPanel'
import type { HistoryRecord } from '@/components/HistoryTable'
import { clearRuntimeConfig, getRuntimeConfig, type RuntimeConfig } from '@/lib/config'
import { useLiveStream, type ServerEvent } from '@/lib/sse'

const LEGACY_STATUS_BASE = 'https://aa85192.github.io/bitfinex-lending-bot-v2/current-status'
const HISTORY_BASE = 'https://aa85192.github.io/bitfinex-lending-bot-v2/funding-statistics-1'

export interface StatusData {
  wallet: { balance: number, available?: number }
  credits: Array<{ id: number; amount: number; rate: number; period: number; mtsOpening: string | number; mtsLastPayout: string | number | null }>
  offers: Array<{ id: number; amount: number; rate: number; period: number }>
  autoRenew: { rate: number; period: number; amount: number } | null
  market?: { frr: number | null, lastTrade: { rate: number, amount: number, mts: number } | null }
  updatedAt: string | number
}

function pct (part: number, total: number) {
  if (total <= 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function SkeletonCard ({ color = '' }: { color?: string }) {
  return (
    <div className={`card ${color}`}>
      <div className="skeleton h-4 w-20 mb-3" />
      <div className="skeleton h-9 w-32" />
      <div className="skeleton h-3 w-16 mt-2" />
    </div>
  )
}

function normalizeFromLive (raw: any): StatusData {
  return {
    wallet: { balance: raw.wallet?.balance ?? 0, available: raw.wallet?.available },
    credits: (raw.credits ?? []).map((c: any) => ({
      id: c.id,
      amount: c.amount,
      rate: c.rate,
      period: c.period,
      mtsOpening: typeof c.mtsOpening === 'number' ? new Date(c.mtsOpening).toISOString() : c.mtsOpening,
      mtsLastPayout: c.mtsLastPayout
        ? (typeof c.mtsLastPayout === 'number' ? new Date(c.mtsLastPayout).toISOString() : c.mtsLastPayout)
        : null,
    })),
    offers: raw.offers ?? [],
    autoRenew: raw.autoRenew,
    market: raw.market,
    updatedAt: typeof raw.updatedAt === 'number' ? new Date(raw.updatedAt).toISOString() : raw.updatedAt,
  }
}

export default function StatusPage () {
  const [currency, setCurrency] = useState('USD')
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [scope, setScope] = useState('/')
  const [data, setData] = useState<StatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [recentEvents, setRecentEvents] = useState<ServerEvent[]>([])

  // bootstrap runtime config from localStorage on mount
  useEffect(() => {
    setCfg(getRuntimeConfig())
    setScope(window.location.pathname.replace(/\/[^/]*$/, '/'))
  }, [])

  // live stream subscription (only if cfg is set)
  const { connected, health, lastError } = useLiveStream({
    cfg,
    currency,
    onState: (payload) => {
      if (payload.currency === currency) {
        setData(normalizeFromLive(payload.state))
        setLoading(false)
        setError(null)
      }
    },
    onEvent: (event) => {
      setRecentEvents(prev => [event, ...prev].slice(0, 20))
    },
  })

  // legacy polling fallback when cfg is NOT set
  const loadLegacyStatus = useCallback(async (cur: string) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${LEGACY_STATUS_BASE}/${cur}.json`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e: any) {
      setError(e.message ?? '取得資料失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async (cur: string) => {
    setHistoryLoading(true); setHistory([])
    try {
      const res = await fetch(`${HISTORY_BASE}/${cur}.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setHistory(await res.json())
    } catch { /* ignore */ } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    loadHistory(currency)
  }, [currency, loadHistory])

  useEffect(() => {
    if (cfg) return // SSE handles it
    loadLegacyStatus(currency)
    const id = setInterval(() => loadLegacyStatus(currency), 60_000)
    return () => clearInterval(id)
  }, [currency, cfg, loadLegacyStatus])

  const handleCurrencyChange = (c: string) => {
    setCurrency(c)
    setData(null)
    if (cfg) setLoading(true) // wait for next SSE state event
  }

  const totalAmount = data?.wallet.balance ?? 0
  const creditsSum = data?.credits.reduce((s, c) => s + c.amount, 0) ?? 0
  const offersSum = data?.offers.reduce((s, o) => s + o.amount, 0) ?? 0
  const availableBalance = Math.max(0, totalAmount - creditsSum - offersSum)

  const updatedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleString('zh-Hant', {
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : null

  const frrLine = data?.market?.frr != null
    ? `市場 FRR ${(data.market.frr * 100).toFixed(4)}%/d`
    : null

  if (showSetup) {
    return (
      <SetupPanel
        initialApiBase={cfg?.apiBase}
        initialViewerToken={cfg?.viewerToken}
        onSaved={() => { setCfg(getRuntimeConfig()); setShowSetup(false); setError(null) }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-3">
            即時狀態
            {cfg && <LiveBadge connected={connected} wsPublic={health?.wsPublic} wsAuth={health?.wsAuth} lastEventAt={health?.lastEventAt} />}
          </h1>
          {updatedAt && !loading && (
            <p className="text-sm text-gray-400 mt-0.5">
              {updatedAt}{frrLine ? ` · ${frrLine}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {cfg && <NotificationButton cfg={cfg} scope={scope} />}
          <button
            onClick={() => setShowSetup(true)}
            className="text-xs text-gray-400 hover:text-emerald-600"
            title="Bot 連線設定"
          >
            {cfg ? '設定' : '連線到 Bot'}
          </button>
          {cfg && (
            <button
              onClick={() => { clearRuntimeConfig(); setCfg(null); setData(null) }}
              className="text-xs text-gray-300 hover:text-rose-500"
              title="登出 / 清除"
            >
              清除
            </button>
          )}
          <CurrencyTabs active={currency} onChange={handleCurrencyChange} />
        </div>
      </div>

      {!cfg && (
        <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-sm text-amber-700">
          目前為 <strong>離線模式</strong>(每分鐘從 GitHub Pages 拉取資料)。
          要啟用即時推播與 WebSocket 串流,請點右上「連線到 Bot」設定 GCP 端 API URL。
        </div>
      )}

      {cfg && lastError && (
        <div className="rounded-xl bg-rose-50 border border-rose-100 px-4 py-3 text-sm text-rose-600">
          串流錯誤: {lastError}
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {loading ? (
          <><SkeletonCard /><SkeletonCard color="bg-emerald-50/60" /><SkeletonCard color="bg-sky-50/60" /></>
        ) : (
          <>
            <MetricCard
              label="投資總額"
              value={totalAmount.toFixed(2)}
              subtitle={`可用餘額 ${availableBalance.toFixed(2)} · ${currency}`}
              color="neutral"
            />
            <MetricCard
              label="已借出"
              value={creditsSum.toFixed(2)}
              subtitle={`${pct(creditsSum, totalAmount)} · ${currency}`}
              color="emerald"
            />
            <MetricCard
              label="掛單中"
              value={offersSum.toFixed(2)}
              subtitle={`${pct(offersSum, totalAmount)} · ${currency}`}
              color="sky"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-1">
          {loading ? (
            <div className="card space-y-3">
              <div className="skeleton h-4 w-24 mb-2" />
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="flex justify-between">
                  <div className="skeleton h-4 w-16" />
                  <div className="skeleton h-4 w-20" />
                </div>
              ))}
            </div>
          ) : (
            <AutoRenewCard autoRenew={data?.autoRenew ?? null} currency={currency} updatedAt={String(data?.updatedAt ?? '')} />
          )}
        </div>
        <div className="lg:col-span-3">
          {loading ? (
            <div className="card p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <div className="skeleton h-4 w-20" />
              </div>
              {[1, 2, 3].map(i => (
                <div key={i} className="px-6 py-4 flex gap-4">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-4 w-16 ml-auto" />
                  <div className="skeleton h-4 w-16" />
                </div>
              ))}
            </div>
          ) : (
            <CreditsTable credits={data?.credits.map(c => ({
              ...c,
              mtsOpening: String(c.mtsOpening),
              mtsLastPayout: c.mtsLastPayout != null ? String(c.mtsLastPayout) : null,
            })) ?? []} />
          )}
        </div>
      </div>

      {cfg && recentEvents.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">最近事件</h2>
          <ul className="divide-y divide-gray-100">
            {recentEvents.map((e, i) => (
              <li key={i} className="py-2 flex items-start justify-between gap-3 text-sm">
                <div>
                  <span className="font-medium text-gray-900">{e.title}</span>
                  <span className="text-gray-500 ml-2">{e.body}</span>
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {new Date(e.receivedAt).toLocaleTimeString('zh-Hant')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">收益圖表</h2>
        <LendingCharts
          records={history}
          loading={historyLoading}
          currency={currency}
          currentTotalAmount={totalAmount}
        />
      </div>
    </div>
  )
}
