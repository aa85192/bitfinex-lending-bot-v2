export interface HistoryRecord {
  date: string
  interest: number
  balance: number
  investment: number
  utilization: number
  dpr: number
  apr1: number
  apr7: number
  apr30: number
  apr365: number
}

interface HistoryTableProps {
  records: HistoryRecord[]
  loading: boolean
}

function fmt(n: number, dp: number) {
  return n.toFixed(dp)
}

export default function HistoryTable({ records, loading }: HistoryTableProps) {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">
          放貸紀錄
        </h2>
        <span className="text-xs text-gray-400">
          {loading ? '載入中…' : `共 ${sorted.length} 筆`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">日期</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">利息</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">餘額</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">使用率</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">1日年化</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">7日年化</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">30日年化</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <div className="skeleton h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-gray-400 text-sm">
                  此區間暫無資料
                </td>
              </tr>
            ) : (
              sorted.map(r => (
                <tr key={r.date} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3.5 font-medium text-gray-900 tabular-nums whitespace-nowrap">
                    {r.date}
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.interest, 8)}
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.balance, 2)}
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.utilization, 2)}%
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-emerald-600 font-medium whitespace-nowrap">
                    {fmt(r.apr1, 2)}%
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-emerald-600 whitespace-nowrap">
                    {fmt(r.apr7, 2)}%
                  </td>
                  <td className="px-6 py-3.5 text-right tabular-nums text-emerald-600 whitespace-nowrap">
                    {fmt(r.apr30, 2)}%
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
