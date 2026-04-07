const cards = [
  {
    label: '1 日年化',
    key: 'apr1' as const,
    bg: 'bg-emerald-50/70',
    border: 'border-emerald-100',
    value: 'text-emerald-700',
  },
  {
    label: '7 日年化',
    key: 'apr7' as const,
    bg: 'bg-teal-50/70',
    border: 'border-teal-100',
    value: 'text-teal-700',
  },
  {
    label: '30 日年化',
    key: 'apr30' as const,
    bg: 'bg-sky-50/70',
    border: 'border-sky-100',
    value: 'text-sky-700',
  },
  {
    label: '年初至今年化',
    key: 'aprYtd' as const,
    bg: 'bg-violet-50/70',
    border: 'border-violet-100',
    value: 'text-violet-700',
  },
]

interface ApyCardsProps {
  apr1: number | null
  apr7: number | null
  apr30: number | null
  aprYtd: number | null
}

export default function ApyCards ({ apr1, apr7, apr30, aprYtd }: ApyCardsProps) {
  const values = { apr1, apr7, apr30, aprYtd }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(c => (
        <div key={c.key} className={`rounded-2xl shadow-sm border ${c.border} ${c.bg} p-6`}>
          <p className="text-sm text-gray-500 mb-1">{c.label}</p>
          {values[c.key] === null ? (
            <div className="skeleton h-9 w-28" />
          ) : (
            <p className={`text-3xl font-semibold tabular-nums ${c.value}`}>
              {values[c.key]!.toFixed(2)}%
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
