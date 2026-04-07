interface ApyCardsProps {
  apr1: number | null
  apr7: number | null
  apr30: number | null
  aprYtd: number | null
}

function ApyCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="card">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      {value === null ? (
        <div className="skeleton h-9 w-28" />
      ) : (
        <p className="text-3xl font-semibold tabular-nums text-emerald-600">
          {value.toFixed(2)}%
        </p>
      )}
    </div>
  )
}

export default function ApyCards({ apr1, apr7, apr30, aprYtd }: ApyCardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <ApyCard label="1 日年化" value={apr1} />
      <ApyCard label="7 日年化" value={apr7} />
      <ApyCard label="30 日年化" value={apr30} />
      <ApyCard label="年初至今年化" value={aprYtd} />
    </div>
  )
}
