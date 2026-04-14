interface AutoRenewInfo {
  rate: number
  period: number
  amount: number
}

function fmt(n: number, dp: number) {
  return n.toFixed(dp)
}

interface AutoRenewCardProps {
  autoRenew: AutoRenewInfo | null
  currency: string
  updatedAt?: string
  borrowedApr?: number
  totalApr?: number
}

export default function AutoRenewCard({ autoRenew, currency, updatedAt, borrowedApr, totalApr }: AutoRenewCardProps) {
  const formattedTime = updatedAt
    ? new Date(updatedAt).toLocaleString('zh-Hant', {
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-medium text-gray-700">當前收益與設定</p>
        {formattedTime && (
          <p className="text-xs text-gray-400">更新於 {formattedTime}</p>
        )}
      </div>
      
      <div className="space-y-3">
        <Row label="幣種" value={currency} />
        
        {borrowedApr !== undefined && totalApr !== undefined && (
          <div className="py-2 border-y border-gray-50 space-y-3">
            <Row label="借出 APR" value={`${fmt(borrowedApr, 2)}%`} accent />
            <Row label="綜合 APR" value={`${fmt(totalApr, 2)}%`} />
          </div>
        )}

        {autoRenew ? (
          <>
            <Row label="掛單日利率" value={`${fmt(autoRenew.rate * 100, 4)}%`} />
            <Row label="掛單年利率" value={`${fmt(autoRenew.rate * 365 * 100, 2)}%`} />
            <Row label="出借天數" value={`${autoRenew.period} 天`} />
          </>
        ) : (
          <p className="text-sm text-gray-400 pt-2">暫無掛單設定</p>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${accent ? 'text-emerald-600' : 'text-gray-900'}`}>
        {value}
      </span>
    </div>
  )
}
