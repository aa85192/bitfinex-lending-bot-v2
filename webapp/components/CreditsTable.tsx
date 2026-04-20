'use client'

import { useEffect, useState } from 'react'

interface CreditInfo {
  id: number
  amount: number
  rate: number
  period: number
  mtsOpening: string
  mtsLastPayout: string | null
}

function fmtDate(iso: string) {
  return iso.slice(0, 10)
}

function getDeadline(mtsOpening: string, period: number): Date {
  return new Date(new Date(mtsOpening).getTime() + period * 24 * 60 * 60 * 1000)
}

function fmtDeadline(deadline: Date): string {
  return deadline.toLocaleString('zh-Hant', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtRemaining(deadline: Date, now: Date): string {
  const diff = deadline.getTime() - now.getTime()
  if (diff <= 0) return '歸還中'
  const totalMinutes = Math.floor(diff / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours === 0 ? `${minutes} 分` : `${hours} 小時 ${minutes} 分`
}

interface CreditsTableProps {
  credits: CreditInfo[]
}

export default function CreditsTable({ credits }: CreditsTableProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="text-sm font-medium text-gray-700">
          出借明細
          <span className="ml-2 text-xs font-normal text-gray-400">
            共 {credits.length} 筆
          </span>
        </h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">金額</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">日利率</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">年利率</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">天數</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">開始日期</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">歸還期限</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">剩餘時間</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {credits.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">
                  目前無出借中訂單
                </td>
              </tr>
            ) : (
              credits.map(c => {
                const deadline = getDeadline(c.mtsOpening, c.period)
                const remainingText = fmtRemaining(deadline, now)
                return (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-medium tabular-nums text-gray-900">
                      {c.amount.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-gray-600">
                      {(c.rate * 100).toFixed(4)}%
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-emerald-600 font-medium">
                      {(c.rate * 365 * 100).toFixed(2)}%
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-gray-600">
                      {c.period} 天
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-gray-500">
                      {fmtDate(c.mtsOpening)}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-gray-500">
                      {fmtDeadline(deadline)}
                    </td>
                    <td className={`px-6 py-4 text-right tabular-nums ${remainingText === '歸還中' ? 'text-amber-500 font-medium' : 'text-gray-500'}`}>
                      {remainingText}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
