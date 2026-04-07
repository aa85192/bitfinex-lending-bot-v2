'use client'

import { useEffect, useState, useMemo } from 'react'
import CurrencyTabs from '@/components/CurrencyTabs'
import ApyCards from '@/components/ApyCards'
import DateRangePicker from '@/components/DateRangePicker'
import HistoryTable, { type HistoryRecord } from '@/components/HistoryTable'

const BASE_URL = 'https://aa85192.github.io/bitfinex-lending-bot-v2/funding-statistics-1'

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toDateStr(d)
}

function avg(arr: number[]) {
  if (arr.length === 0) return null
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

export default function HistoryPage() {
  const [currency, setCurrency] = useState('USD')
  const [allData, setAllData] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [startDate, setStartDate] = useState(daysAgo(30))
  const [endDate, setEndDate] = useState(toDateStr(new Date()))

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)
      setAllData([])
      try {
        const res = await fetch(`${BASE_URL}/${currency}.json`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setAllData(await res.json())
      } catch (e: any) {
        setError(e.message ?? '載入失敗')
      } finally {
        setLoading(false)
      }
    }

    loadData()

    // Auto-refresh history data every 5 minutes
    const refreshInterval = setInterval(loadData, 300_000)

    return () => clearInterval(refreshInterval)
  }, [currency])

  // APY summary — from latest record
  const latest = useMemo(() => {
    if (allData.length === 0) return null
    return [...allData].sort((a, b) => b.date.localeCompare(a.date))[0]
  }, [allData])

  // YTD APY
  const aprYtd = useMemo(() => {
    const year = new Date().getFullYear()
    const ytd = allData.filter(r => r.date >= `${year}-01-01` && r.apr1 > 0)
    return avg(ytd.map(r => r.apr1))
  }, [allData])

  // Filtered records for custom date range
  const filteredRecords = useMemo(() => {
    return allData.filter(r => r.date >= startDate && r.date <= endDate)
  }, [allData, startDate, endDate])

  // Period APY for custom range
  const periodApy = useMemo(() => {
    const valid = filteredRecords.filter(r => r.apr1 > 0)
    return avg(valid.map(r => r.apr1))
  }, [filteredRecords])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">歷史紀錄</h1>
        <CurrencyTabs active={currency} onChange={c => { setCurrency(c) }} />
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* APY summary */}
      <ApyCards
        apr1={loading ? null : (latest?.apr1 ?? null)}
        apr7={loading ? null : (latest?.apr7 ?? null)}
        apr30={loading ? null : (latest?.apr30 ?? null)}
        aprYtd={loading ? null : aprYtd}
      />

      {/* Date range + history table */}
      <DateRangePicker
        startDate={startDate}
        endDate={endDate}
        periodApy={loading ? null : periodApy}
        onStartChange={setStartDate}
        onEndChange={setEndDate}
      />

      <HistoryTable records={filteredRecords} loading={loading} />
    </div>
  )
}
