'use client'

import { useState, useMemo } from 'react'
import {
  ComposedChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts'
import type { HistoryRecord } from './HistoryTable'

type Grouping = 'day' | 'week' | 'month'
type Preset = '7d' | '30d' | '90d' | '1y' | 'custom'

interface ChartPoint {
  date: string
  label: string
  interest: number
  
  // 放貸年化 (APY)
  aprHistorical: number      // 借出當下的換算 (總高度)
  aprDilutedTrue: number     // 綜合換算真實值 (以目前本金計算)
  aprBottomRender: number    // 底部渲染高度 (受安全閥保護)
  aprTopRender: number       // 頂部差額高度

  // 資金利用率 (Util)
  utilHistorical: number     // 借出當下的利用率 (總高度，不固定)
  utilDilutedTrue: number    // 綜合換算真實值 (以目前本金計算)
  utilBottomRender: number   // 底部渲染高度 (受安全閥保護)
  utilTopRender: number      // 頂部差額高度
}

function toISO (d: Date) { return d.toISOString().slice(0, 10) }
function daysAgo (n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toISO(d)
}
function startOfWeek (dateStr: string) {
  const d = new Date(dateStr)
  const day = d.getDay()
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1))
  return toISO(d)
}

function aggregateRecords (records: HistoryRecord[], grouping: Grouping, currentTotalAmount: number): ChartPoint[] {
  // 避免除以 0 的保護機制
  const safeTotal = currentTotalAmount > 0 ? currentTotalAmount : 1;

  if (grouping === 'day') {
    return records.map(r => {
      // API 紀錄的投資本金與實際借出額
      const histInv = (r as any).investment || 0;
      const histLentAmount = (histInv * r.utilization) / 100;

      // === 1. 放貸年化邏輯 ===
      const aprHistorical = r.apr1 || 0; // (1) 借出當下的換算apy(以成交當天帳戶總共可用資金計算)
      const aprDiluted = (r.interest * 365 * 100) / safeTotal; // (2) 綜合換算apy(以目前帳戶總共可用資金計算)

      // === 2. 資金利用率邏輯 ===
      const utilHistorical = r.utilization || 0; // (1) 借出當下的資金利用率 (決定整根柱子總高度)
      const utilDiluted = (histLentAmount / safeTotal) * 100; // (2) 綜合換算資金利用率（以全部目前資金當分母）

      return {
        date: r.date,
        label: r.date.slice(5).replace('-', '/'),
        interest: r.interest,

        aprHistorical,
        aprDilutedTrue: aprDiluted,
        // 安全閥：防止因歷史出金導致「目前綜合換算」大於「當天換算」而破圖
        aprBottomRender: Math.min(aprHistorical, aprDiluted),
        aprTopRender: Math.max(0, aprHistorical - aprDiluted),

        utilHistorical,
        utilDilutedTrue: utilDiluted,
        // 安全閥：同上
        utilBottomRender: Math.min(utilHistorical, utilDiluted),
        utilTopRender: Math.max(0, utilHistorical - utilDiluted),
      }
    })
  }

  // 週/月分組邏輯
  type G = {
    date: string
    label: string
    interest: number
    investment: number
    lentAmount: number
    n: number
  }
  const groups: Record<string, G> = {}

  for (const r of records) {
    let key: string, label: string
    if (grouping === 'week') {
      key = startOfWeek(r.date)
      const d = new Date(key)
      label = `${d.getMonth() + 1}/${d.getDate()}`
    } else {
      key = r.date.slice(0, 7)
      label = `${parseInt(r.date.slice(5, 7))}月`
    }
    const g = (groups[key] ??= { date: key, label, interest: 0, investment: 0, lentAmount: 0, n: 0 })
    
    const histInv = (r as any).investment || 0;
    const histLentAmount = (histInv * r.utilization) / 100;

    g.interest += r.interest
    g.investment += histInv
    g.lentAmount += histLentAmount
    g.n++
  }

  return Object.values(groups)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(g => {
      // 週/月分組不要直接平均百分比，改用「先加總分子/分母再換算」
      // 以避免不同本金日子被同權重平均，造成年化/利用率失真。
      const avgAprHist = g.investment > 0 ? (g.interest * 365 * 100) / g.investment : 0
      const avgAprDil = g.n > 0 ? (g.interest * 365 * 100) / (safeTotal * g.n) : 0
      const avgUtilHist = g.investment > 0 ? (g.lentAmount * 100) / g.investment : 0
      const avgUtilDil = g.n > 0 ? (g.lentAmount * 100) / (safeTotal * g.n) : 0

      return {
        date: g.date,
        label: g.label,
        interest: g.interest,

        aprHistorical: avgAprHist,
        aprDilutedTrue: avgAprDil,
        aprBottomRender: Math.min(avgAprHist, avgAprDil),
        aprTopRender: Math.max(0, avgAprHist - avgAprDil),

        utilHistorical: avgUtilHist,
        utilDilutedTrue: avgUtilDil,
        utilBottomRender: Math.min(avgUtilHist, avgUtilDil),
        utilTopRender: Math.max(0, avgUtilHist - avgUtilDil),
      }
    })
}

function tickInterval (count: number, isMobile: boolean) {
  const maxTicks = isMobile ? 6 : 14
  return count <= maxTicks ? 0 : Math.ceil(count / maxTicks) - 1
}

// ─── custom tooltips ─────────────────────────────────────────────────────────

function InterestTooltip ({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const v = payload[0]?.value as number
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2 text-xs">
      <p className="text-gray-500 mb-1">{label}</p>
      <p className="font-semibold text-indigo-600">{v?.toFixed(8)}</p>
    </div>
  )
}

function ApyTooltip ({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload as ChartPoint
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2.5 text-xs space-y-2 min-w-[180px]">
      <p className="text-gray-500 mb-1 border-b border-gray-50 pb-1">{label}</p>
      <div className="flex justify-between items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-sm bg-emerald-200" />
          <span className="text-gray-500">借出當下換算 (歷史本金)</span>
        </div>
        <span className="font-semibold text-gray-900">{data.aprHistorical?.toFixed(2)}%</span>
      </div>
      <div className="flex justify-between items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-sm bg-emerald-500" />
          <span className="text-gray-500">綜合換算 (以今日總金)</span>
        </div>
        <span className="font-semibold text-gray-900">{data.aprDilutedTrue?.toFixed(2)}%</span>
      </div>
    </div>
  )
}

function UtilTooltip ({ active, payload, label, isUsd }: any) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload as ChartPoint
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2.5 text-xs space-y-2 min-w-[180px]">
      <p className="text-gray-500 mb-1 border-b border-gray-50 pb-1">{label}</p>
      <div className="flex justify-between items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-sm bg-blue-500" />
          <span className="text-gray-500">借出當下利用率</span>
        </div>
        <span className="font-semibold text-gray-900">{data.utilHistorical?.toFixed(1)}%</span>
      </div>
      {!isUsd && (
        <div className="flex justify-between items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm bg-blue-200" />
            <span className="text-gray-500">綜合換算利用率 (以今日總金)</span>
          </div>
          <span className="font-semibold text-gray-900">{data.utilDilutedTrue?.toFixed(1)}%</span>
        </div>
      )}
    </div>
  )
}

// ─── controls ────────────────────────────────────────────────────────────────

const PRESETS: { label: string; value: Preset; days?: number }[] = [
  { label: '7天', value: '7d', days: 7 },
  { label: '30天', value: '30d', days: 30 },
  { label: '90天', value: '90d', days: 90 },
  { label: '1年', value: '1y', days: 365 },
  { label: '自訂', value: 'custom' },
]

const GROUPINGS: { label: string; value: Grouping }[] = [
  { label: '日', value: 'day' },
  { label: '週', value: 'week' },
  { label: '月', value: 'month' },
]

function ChartCard ({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-5 pt-5 pb-2">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="pb-4 pr-2">{children}</div>
    </div>
  )
}

function ChartSkeleton () {
  return (
    <div className="card">
      <div className="skeleton h-4 w-32 mb-4" />
      <div className="skeleton h-44 w-full rounded-xl" />
    </div>
  )
}

// ✅ 確保介面接收 currentTotalAmount
interface LendingChartsProps {
  records: HistoryRecord[]
  loading: boolean
  currency: string
  currentTotalAmount: number
}

export default function LendingCharts ({ records, loading, currency, currentTotalAmount }: LendingChartsProps) {
  const [grouping, setGrouping] = useState<Grouping>('day')
  const [preset, setPreset] = useState<Preset>('30d')
  const [startDate, setStartDate] = useState(daysAgo(30))
  const [endDate, setEndDate] = useState(toISO(new Date()))

  const handlePreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      const days = PRESETS.find(x => x.value === p)?.days ?? 30
      setStartDate(daysAgo(days))
      setEndDate(toISO(new Date()))
    }
  }

  const filtered = useMemo(() => {
    return records
      .filter(r => r.date >= startDate && r.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [records, startDate, endDate])

  // 傳入 currentTotalAmount 給彙整函數
  const data = useMemo(() => aggregateRecords(filtered, grouping, currentTotalAmount), [filtered, grouping, currentTotalAmount])
  const interval = useMemo(() => tickInterval(data.length, false), [data.length])
  const axisStyle = { fontSize: 11, fill: '#9ca3af' }

  if (loading) {
    return <div className="space-y-4"><ChartSkeleton /><ChartSkeleton /><ChartSkeleton /></div>
  }

  if (records.length === 0) {
    return <div className="card text-center text-sm text-gray-400 py-10">歷史資料尚未載入</div>
  }

  return (
    <div className="space-y-5">
      {/* ── controls ── */}
      <div className="card py-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">柱寬</span>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {GROUPINGS.map(g => (
                <button
                  key={g.value}
                  onClick={() => setGrouping(g.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    grouping === g.value ? 'bg-emerald-500 text-white' : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {PRESETS.map(p => (
                <button
                  key={p.value}
                  onClick={() => handlePreset(p.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    preset === p.value ? 'bg-emerald-500 text-white' : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="flex items-center gap-1.5 text-sm">
                <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700" />
                <span className="text-gray-300">—</span>
                <input type="date" value={endDate} min={startDate} max={toISO(new Date())} onChange={e => setEndDate(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── chart 1: 放貸利息 ── */}
      <ChartCard title={`${currency} 放貸利息`}>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradInterest" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#818cf8" stopOpacity={0.95} />
                <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.8} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis tick={axisStyle} axisLine={false} tickLine={false} tickFormatter={v => v === 0 ? '0' : v.toFixed(3)} width={48} />
            <Tooltip content={<InterestTooltip />} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
            <Bar dataKey="interest" fill="url(#gradInterest)" radius={[4, 4, 0, 0]} maxBarSize={32} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── chart 2: 放貸年化 (疊加柱狀) ── */}
      <ChartCard title={`${currency} 放貸年化`}>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis tick={axisStyle} axisLine={false} tickLine={false} tickFormatter={v => `${v.toFixed(1)}%`} width={48} />
            <Tooltip content={<ApyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            
            {/* 底層：綜合換算 APR (深綠色實心) */}
            <Bar dataKey="aprBottomRender" stackId="apr" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={32} />
            {/* 頂層：借出當下 APR 差額 (淺綠色半透明) */}
            <Bar dataKey="aprTopRender" stackId="apr" fill="#a7f3d0" radius={[4, 4, 0, 0]} maxBarSize={32} />
            
            <Legend
              content={() => (
                <div className="flex items-center justify-center gap-5 mt-3 text-xs text-gray-500">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-[#10b981]" />
                    <span>綜合換算 (以目前總金計算)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm bg-[#a7f3d0]" />
                    <span>借出當下換算 (總高度)</span>
                  </div>
                </div>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── chart 3: 資金利用率 (疊加柱狀) ── */}
      <ChartCard title={`${currency} 資金利用率`}>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 'auto']} tick={axisStyle} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} width={40} />
            <Tooltip content={(props) => <UtilTooltip {...props} isUsd={currency === 'USD'} />} cursor={{ fill: 'rgba(59,130,246,0.06)' }} />

            {currency === 'USD' ? (
              /* USD：只顯示借出當下利用率 */
              <Bar dataKey="utilHistorical" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={32} />
            ) : (
              <>
                {/* 底層：綜合換算資金利用率 (深藍色實心) */}
                <Bar dataKey="utilBottomRender" stackId="util" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={32} />
                {/* 頂層：歷史當下借出利用率的差額 (淺藍色) */}
                <Bar dataKey="utilTopRender" stackId="util" fill="#bfdbfe" radius={[4, 4, 0, 0]} maxBarSize={32} />
              </>
            )}

            <Legend
              content={() => (
                <div className="flex items-center justify-center gap-5 mt-3 text-xs text-gray-500">
                  {currency === 'USD' ? (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm bg-[#3b82f6]" />
                      <span>借出當下利用率</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-sm bg-[#3b82f6]" />
                        <span>綜合換算利用率 (以目前總金)</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-sm bg-[#bfdbfe]" />
                        <span>借出當下利用率 (總高度)</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  )
}
