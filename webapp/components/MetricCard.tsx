type ColorScheme = 'neutral' | 'emerald' | 'sky' | 'teal' | 'violet' | 'amber'

const colorMap: Record<ColorScheme, { bg: string; value: string; border: string }> = {
  neutral: { bg: 'bg-white', value: 'text-gray-900', border: 'border-gray-100' },
  emerald: { bg: 'bg-emerald-50/70', value: 'text-emerald-700', border: 'border-emerald-100' },
  sky:     { bg: 'bg-sky-50/70',     value: 'text-sky-700',     border: 'border-sky-100' },
  teal:    { bg: 'bg-teal-50/70',    value: 'text-teal-700',    border: 'border-teal-100' },
  violet:  { bg: 'bg-violet-50/70',  value: 'text-violet-700',  border: 'border-violet-100' },
  amber:   { bg: 'bg-amber-50/70',   value: 'text-amber-700',   border: 'border-amber-100' },
}

interface MetricCardProps {
  label: string
  value: string
  subtitle?: string
  color?: ColorScheme
}

export default function MetricCard ({ label, value, subtitle, color = 'neutral' }: MetricCardProps) {
  const c = colorMap[color]
  return (
    <div className={`rounded-2xl shadow-sm border ${c.border} ${c.bg} p-6`}>
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-semibold tabular-nums ${c.value}`}>{value}</p>
      {subtitle && (
        <p className="text-sm text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  )
}
