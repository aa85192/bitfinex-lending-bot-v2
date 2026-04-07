'use client'

import { useEffect, useState, useCallback } from 'react'
import CurrencyTabs from '@/components/CurrencyTabs'
import MetricCard from '@/components/MetricCard'
import AutoRenewCard from '@/components/AutoRenewCard'
import CreditsTable from '@/components/CreditsTable'
import LendingCharts from '@/components/LendingCharts'
import type { HistoryRecord } from '@/components/HistoryTable'

const STATUS_BASE = 'https://aa85192.github.io/bitfinex-lending-bot-v2/current-status'
const HISTORY_BASE = 'https://aa85192.github.io/bitfinex-lending-bot-v2/funding-statistics-1'

export interface StatusData {
  wallet: { balance: number }
  credits: Array<{ id: number; amount: number; rate: number; period: number; mtsOpening: string; mtsLastPayout: string | null }>
  offers: Array<{ id: number; amount: number; rate: number; period: number }>
  autoRenew: { rate: number; period: number; amount: number } | null
  updatedAt: string
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

export default function StatusPage () {
  const [currency, setCurrency] = useState('USD')
  const [data, setData] = useState<StatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  // Fetch current status
  const loadStatus = useCallback(async (cur: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${STATUS_BASE}/${cur}.json`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e: any) {
      setError(e.message ?? '取得資料失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch history data for charts
  const loadHistory = useCallback(async (cur: string) => {
    setHistoryLoading(true)
    setHistory([])
    try {
      const res = await fetch(`${HISTORY_BASE}/${cur}.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setHistory(await res.json())
    } catch {
      // silently ignore — charts will show empty state
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus(currency)
    loadHistory(currency)

    // Auto-refresh current status every 60 seconds
    const refreshInterval = setInterval(() => {
      loadStatus(currency)
    }, 60_000)

    return () => clearInterval(refreshInterval)
  }, [currency, loadStatus, loadHistory])

  const handleCurrencyChange = (c: string) => {
    setCurrency(c)
    setData(null)
  }

  const creditsSum = data?.credits.reduce((s, c) => s + c.amount, 0) ?? 0
  const offersSum = data?.offers.reduce((s, o) => s + o.amount, 0) ?? 0
  const balance = data?.wallet.balance ?? 0

  const updatedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleString('zh-Hant', {
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">即時狀態</h1>
          {updatedAt && !loading && (
            <p className="text-sm text-gray-400 mt-0.5">資料更新於 {updatedAt}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!loading && (
            <button
              onClick={() => loadStatus(currency)}
              className="text-sm text-gray-400 hover:text-emerald-600 transition-colors"
              title="重新整理"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </button>
          )}
          <CurrencyTabs active={currency} onChange={handleCurrencyChange} />
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
          {error}
          {error.includes('404') && (
            <span className="ml-1 text-red-400">（資料尚未產生，請等待 GitHub Actions 執行後再重試）</span>
          )}
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {loading ? (
          <><SkeletonCard /><SkeletonCard color="bg-emerald-50/60" /><SkeletonCard color="bg-sky-50/60" /></>
        ) : (
          <>
            <MetricCard
              label="投資總額"
              value={balance.toFixed(2)}
              subtitle={currency}
              color="neutral"
            />
            <MetricCard
              label="已借出"
              value={creditsSum.toFixed(2)}
              subtitle={`${pct(creditsSum, balance)} · ${currency}`}
              color="emerald"
            />
            <MetricCard
              label="掛單中"
              value={offersSum.toFixed(2)}
              subtitle={`${pct(offersSum, balance)} · ${currency}`}
              color="sky"
            />
          </>
        )}
      </div>

      {/* Auto-renew + credits */}
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
            <AutoRenewCard autoRenew={data?.autoRenew ?? null} currency={currency} updatedAt={data?.updatedAt} />
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
            <CreditsTable credits={data?.credits ?? []} />
          )}
        </div>
      </div>

      {/* ── Charts section ── */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">收益圖表</h2>
        <LendingCharts
          records={history}
          loading={historyLoading}
          currency={currency}
        />
      </div>
    </div>
  )
}
