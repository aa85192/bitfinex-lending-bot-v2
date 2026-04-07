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
}

export default function AutoRenewCard({ autoRenew, currency }: AutoRenewCardProps) {
  return (
    <div className="card">
      <p className="text-sm font-medium text-gray-700 mb-4">自動掛單設定</p>
      {autoRenew ? (
        <div className="space-y-3">
          <Row label="幣種" value={currency} />
          <Row
            label="日利率"
            value={`${fmt(autoRenew.rate * 100, 4)}%`}
          />
          <Row
            label="年利率"
            value={`${fmt(autoRenew.rate * 365 * 100, 2)}%`}
            accent
          />
          <Row
            label="出借天數"
            value={`${autoRenew.period} 天`}
          />
        </div>
      ) : (
        <p className="text-sm text-gray-400">暫無設定</p>
      )}
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
