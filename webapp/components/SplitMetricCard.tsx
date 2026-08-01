import { colorMap, type ColorScheme } from './MetricCard'

export interface SplitMetricItem {
  label: string
  value: string
  subtitle?: string
  color?: ColorScheme
  loading?: boolean
}

interface SplitMetricCardProps {
  label: string
  items: SplitMetricItem[]
  color?: ColorScheme
}

export default function SplitMetricCard ({ label, items, color = 'neutral' }: SplitMetricCardProps) {
  const c = colorMap[color]
  return (
    <div className={`rounded-2xl shadow-sm border ${c.border} ${c.bg} p-6`}>
      <p className="text-sm text-gray-500 mb-3">{label}</p>
      <div className="grid grid-cols-2 gap-3">
        {items.map((item, i) => {
          const ic = colorMap[item.color ?? color]
          return (
            <div
              key={item.label}
              className={i > 0 ? 'pl-3 border-l border-gray-200/70' : ''}
            >
              <p className="text-xs text-gray-500 mb-0.5">{item.label}</p>
              {item.loading ? (
                <div className="skeleton h-8 w-20" />
              ) : (
                <p className={`text-2xl font-semibold tabular-nums break-all ${ic.value}`}>
                  {item.value}
                </p>
              )}
              {item.subtitle && (
                <p className="text-xs text-gray-400 mt-0.5">{item.subtitle}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
