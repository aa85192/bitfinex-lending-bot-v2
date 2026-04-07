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

function fmt (n: number, dp: number) {
  return n.toFixed(dp)
}

export default function HistoryTable ({ records, loading }: HistoryTableProps) {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date))

  if (loading) {
    return (
      <div className="card p-0 overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h2 className="text-sm font-medium text-gray-700">放貸紀錄</h2>
        </div>
        <div className="h-96 flex items-center justify-center text-sm text-gray-400">
          <div className="skeleton h-32 w-3/4 rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="card p-0 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">放貸紀錄</h2>
        <span className="text-xs text-gray-400">
          {sorted.length > 0 ? `共 ${sorted.length} 筆` : '暫無資料'}
        </span>
      </div>

      {/* Scrollable container */}
      {sorted.length === 0 ? (
        <div className="h-96 flex items-center justify-center text-sm text-gray-400">
          此區間暫無資料
        </div>
      ) : (
        <div
          className="overflow-x-auto overflow-y-auto flex-1"
          style={{
            height: '400px',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr>
                <th className="sticky left-0 bg-gray-50 z-20 px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap border-r border-gray-100">
                  日期
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">利息</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">餘額</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">使用率</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">1日年化</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">7日年化</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">30日年化</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(r => (
                <tr key={r.date} className="hover:bg-gray-50/50 transition-colors">
                  {/* Sticky date column */}
                  <td className="sticky left-0 bg-white hover:bg-gray-50/50 z-10 px-5 py-3 font-semibold text-gray-900 tabular-nums whitespace-nowrap border-r border-gray-100">
                    {r.date}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.interest, 8)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.balance, 2)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 whitespace-nowrap">
                    {fmt(r.utilization, 2)}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600 font-medium whitespace-nowrap">
                    {fmt(r.apr1, 2)}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-teal-600 font-medium whitespace-nowrap">
                    {fmt(r.apr7, 2)}%
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-sky-600 font-medium whitespace-nowrap">
                    {fmt(r.apr30, 2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Scroll hint for mobile */}
      <div className="hidden sm:flex px-5 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-400 items-center justify-end gap-1">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        向右滑動查看更多資料
      </div>
    </div>
  )
}
