import type { CreditInfo } from '@/lib/bitfinex-server'

function fmtDate(iso: string) {
  return iso.slice(0, 10)
}

interface CreditsTableProps {
  credits: CreditInfo[]
}

export default function CreditsTable({ credits }: CreditsTableProps) {
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
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">金額</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">日利率</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">年利率</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">天數</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">開始日期</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {credits.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-400 text-sm">
                  目前無出借中訂單
                </td>
              </tr>
            ) : (
              credits.map(c => (
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
