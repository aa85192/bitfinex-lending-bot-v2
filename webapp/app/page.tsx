'use client'

import { useEffect, useState, useCallback } from 'react'
import CurrencyTabs from '@/components/CurrencyTabs'
import MetricCard from '@/components/MetricCard'
import AutoRenewCard from '@/components/AutoRenewCard'
import CreditsTable from '@/components/CreditsTable'
import type { StatusResponse } from '@/lib/bitfinex-server'

function pct(part: number, total: number) {
  if (total <= 0) return '0.00%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function SkeletonCard() {
  return (
    <div className="card">
      <div className="skeleton h-4 w-20 mb-3" />
      <div className="skeleton h-9 w-32" />
      <div className="skeleton h-3 w-16 mt-2" />
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
      {message}
    </div>
  )
}

export default function StatusPage() {
  const [currency, setCurrency] = useState('USD')
  const [data, setData] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const load = useCallback(async (cur: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/status?currency=${cur}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json: StatusResponse = await res.json()
      setData(json)
      setUpdatedAt(new Date(json.updatedAt).toLocaleTimeString('zh-Hant', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }))
    } catch (e: any) {
      setError(e.message ?? '取得資料失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(currency)
    const id = setInterval(() => load(currency), 60_000)
    return () => clearInterval(id)
  }, [currency, load])

  const handleCurrencyChange = (c: string) => {
    setCurrency(c)
    setData(null)
  }

  const creditsSum = data?.credits.reduce((s, c) => s + c.amount, 0) ?? 0
  const offersSum = data?.offers.reduce((s, o) => s + o.amount, 0) ?? 0
  const balance = data?.wallet.balance ?? 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">即時狀態</h1>
          {updatedAt && !loading && (
            <p className="text-sm text-gray-400 mt-0.5">最後更新：{updatedAt}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!loading && (
            <button
              onClick={() => load(currency)}
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

      {error && <ErrorBanner message={error} />}

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              label="投資總額"
              value={`${balance.toFixed(2)}`}
              subtitle={currency}
            />
            <MetricCard
              label="已借出"
              value={`${creditsSum.toFixed(2)}`}
              subtitle={`${pct(creditsSum, balance)} · ${currency}`}
              accent
            />
            <MetricCard
              label="掛單中"
              value={`${offersSum.toFixed(2)}`}
              subtitle={`${pct(offersSum, balance)} · ${currency}`}
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
              {[1,2,3,4].map(i => (
                <div key={i} className="flex justify-between">
                  <div className="skeleton h-4 w-16" />
                  <div className="skeleton h-4 w-20" />
                </div>
              ))}
            </div>
          ) : (
            <AutoRenewCard autoRenew={data?.autoRenew ?? null} currency={currency} />
          )}
        </div>
        <div className="lg:col-span-3">
          {loading ? (
            <div className="card p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <div className="skeleton h-4 w-20" />
              </div>
              <div className="divide-y divide-gray-50">
                {[1,2,3].map(i => (
                  <div key={i} className="px-6 py-4 flex gap-4">
                    <div className="skeleton h-4 w-24" />
                    <div className="skeleton h-4 w-16 ml-auto" />
                    <div className="skeleton h-4 w-16" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <CreditsTable credits={data?.credits ?? []} />
          )}
        </div>
      </div>
    </div>
  )
}
