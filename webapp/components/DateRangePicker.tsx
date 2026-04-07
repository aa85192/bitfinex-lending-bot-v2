'use client'

interface DateRangePickerProps {
  startDate: string
  endDate: string
  periodApy: number | null
  onStartChange: (v: string) => void
  onEndChange: (v: string) => void
}

export default function DateRangePicker({
  startDate,
  endDate,
  periodApy,
  onStartChange,
  onEndChange,
}: DateRangePickerProps) {
  return (
    <div className="card">
      <h2 className="text-sm font-medium text-gray-700 mb-4">自訂區間分析</h2>
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-gray-500 mb-1.5">開始日期</label>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={e => onStartChange(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
        <div className="hidden sm:block text-gray-300 pb-2">—</div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-gray-500 mb-1.5">結束日期</label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            max={new Date().toISOString().slice(0, 10)}
            onChange={e => onEndChange(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>

        {/* Period APY result */}
        {periodApy !== null && (
          <div className="sm:ml-4 bg-emerald-50 rounded-xl px-5 py-2.5 border border-emerald-100 flex-shrink-0">
            <p className="text-xs text-emerald-600 mb-0.5">區間年化</p>
            <p className="text-2xl font-semibold tabular-nums text-emerald-700">
              {periodApy.toFixed(2)}%
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
