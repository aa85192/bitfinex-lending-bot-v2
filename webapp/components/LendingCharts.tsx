'use client'

import { useState, useMemo } from 'react'
import {
  ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from 'recharts'
import type { HistoryRecord } from './HistoryTable'

// ─── types ──────────────────────────────────────────────────────────────────

type Grouping = 'day' | 'week' | 'month'
type Preset = '7d' | '30d' | '90d' | '1y' | 'custom'

interface ChartPoint {
  date: string
  label: string
  interest: number
  apr1: number
  apr7: number
  apr30: number
  utilization: number
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

function aggregateRecords (records: HistoryRecord[], grouping: Grouping): ChartPoint[] {
  if (grouping === 'day') {
    return records.map(r => ({
      date: r.date,
      label: r.date.slice(5).replace('-', '/'),
      interest: r.interest,
      apr1: r.apr1,
      apr7: r.apr7,
      apr30: r.apr30,
      utilization: r.utilization,
    }))
  }

  type G = { date: string; label: string; interest: number; s1: number; s7: number; s30: number; su: number; n: number }
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
    const g = (groups[key] ??= { date: key, label, interest: 0, s1: 0, s7: 0, s30: 0, su: 0, n: 0 })
    g.interest += r.interest
    g.s1 += r.apr1
    g.s7 += r.apr7
    g.s30 += r.apr30
    g.su += r.utilization
    g.n++
  }

  return Object.values(groups)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(g => ({
      date: g.date,
      label: g.label,
      interest: g.interest,
      apr1: g.n > 0 ? g.s1 / g.n : 0,
      apr7: g.n > 0 ? g.s7 / g.n : 0,
      apr30: g.n > 0 ? g.s30 / g.n : 0,
      utilization: g.n > 0 ? g.su / g.n : 0,
    }))
}

// auto-skip X-axis ticks to avoid crowding
function tickInterval (count: number, isMobile: boolean) {
  const maxTicks = isMobile ? 6 : 14
  return count <= maxTicks ? 0 : Math.ceil(count / maxTicks) - 1
}

// ─── custom tooltip ──────────────────────────────────────────────────────────

function InterestTooltip ({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const v = payload[0]?.value as number
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2 text-xs">
      <p className="text-gray-500 mb-1">{label}</p>
      <p className="font-semibold text-emerald-600">{v?.toFixed(8)}</p>
    </div>
  )
}

function ApyTooltip ({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const find = (name: string) => payload.find((p: any) => p.dataKey === name)?.value as number | undefined
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2 text-xs space-y-1">
      <p className="text-gray-500 mb-0.5">{label}</p>
      {find('apr1') != null && <p><span className="text-gray-400">1日年化　</span><span className="font-semibold text-emerald-600">{find('apr1')?.toFixed(2)}%</span></p>}
      {find('apr7') != null && <p><span className="text-gray-400">7日年化　</span><span className="font-semibold text-teal-500">{find('apr7')?.toFixed(2)}%</span></p>}
      {find('apr30') != null && <p><span className="text-gray-400">30日年化　</span><span className="font-semibold text-violet-500">{find('apr30')?.toFixed(2)}%</span></p>}
    </div>
  )
}

function UtilTooltip ({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const v = payload[0]?.value as number
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-3 py-2 text-xs">
      <p className="text-gray-500 mb-1">{label}</p>
      <p className="font-semibold text-lime-600">{v?.toFixed(1)}%</p>
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

// ─── chart card wrapper ───────────────────────────────────────────────────────

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

// ─── skeleton ────────────────────────────────────────────────────────────────

function ChartSkeleton () {
  return (
    <div className="card">
      <div className="skeleton h-4 w-32 mb-4" />
      <div className="skeleton h-44 w-full rounded-xl" />
    </div>
  )
}

// ─── main component ──────────────────────────────────────────────────────────

interface LendingChartsProps {
  records: HistoryRecord[]
  loading: boolean
  currency: string
}

export default function LendingCharts ({ records, loading, currency }: LendingChartsProps) {
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

  const data = useMemo(() => aggregateRecords(filtered, grouping), [filtered, grouping])

  // responsive tick interval — approximate mobile as window <= 640
  const interval = useMemo(() => tickInterval(data.length, false), [data.length])

  const axisStyle = { fontSize: 11, fill: '#9ca3af' }

  if (loading) {
    return (
      <div className="space-y-4">
        <ChartSkeleton />
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    )
  }

  if (records.length === 0) {
    return (
      <div className="card text-center text-sm text-gray-400 py-10">
        歷史資料尚未載入
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* ── controls ── */}
      <div className="card py-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          {/* Grouping */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap">柱寬</span>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {GROUPINGS.map(g => (
                <button
                  key={g.value}
                  onClick={() => setGrouping(g.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    grouping === g.value
                      ? 'bg-emerald-500 text-white'
                      : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preset + custom dates */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {PRESETS.map(p => (
                <button
                  key={p.value}
                  onClick={() => handlePreset(p.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    preset === p.value
                      ? 'bg-emerald-500 text-white'
                      : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="flex items-center gap-1.5 text-sm">
                <input
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <span className="text-gray-300">—</span>
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  max={toISO(new Date())}
                  onChange={e => setEndDate(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
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
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
                <stop offset="100%" stopColor="#059669" stopOpacity={0.8} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => v === 0 ? '0' : v.toFixed(3)}
              width={48}
            />
            <Tooltip content={<InterestTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="interest" fill="url(#gradInterest)" radius={[4, 4, 0, 0]} maxBarSize={32} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── chart 2: 放貸年化 ── */}
      <ChartCard title={`${currency} 放貸年化`}>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradApr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a7f3d0" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#6ee7b7" stopOpacity={0.6} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => `${v.toFixed(1)}%`}
              width={48}
            />
            <Tooltip content={<ApyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="apr1" fill="url(#gradApr)" radius={[4, 4, 0, 0]} maxBarSize={32} name="apr1" />
            <Line type="monotone" dataKey="apr7" stroke="#14b8a6" strokeWidth={2} dot={false} name="apr7" />
            <Line type="monotone" dataKey="apr30" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 3" dot={false} name="apr30" />
            <Legend
              iconType="circle"
              iconSize={8}
              formatter={(value) => {
                if (value === 'apr1') return <span style={{ fontSize: 11, color: '#6b7280' }}>1日年化</span>
                if (value === 'apr7') return <span style={{ fontSize: 11, color: '#6b7280' }}>7日年化</span>
                if (value === 'apr30') return <span style={{ fontSize: 11, color: '#6b7280' }}>30日年化</span>
                return value
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── chart 3: 資金利用率 ── */}
      <ChartCard title={`${currency} 資金利用率`}>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradUtil" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#bef264" stopOpacity={0.95} />
                <stop offset="100%" stopColor="#84cc16" stopOpacity={0.75} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={axisStyle} interval={interval} axisLine={false} tickLine={false} />
            <YAxis
              domain={[0, 100]}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => `${v}%`}
              width={40}
            />
            <Tooltip content={<UtilTooltip />} cursor={{ fill: 'rgba(132,204,22,0.06)' }} />
            <Bar dataKey="utilization" fill="url(#gradUtil)" radius={[4, 4, 0, 0]} maxBarSize={32} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  )
}
