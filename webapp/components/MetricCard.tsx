interface MetricCardProps {
  label: string
  value: string
  subtitle?: string
  accent?: boolean
}

export default function MetricCard({ label, value, subtitle, accent = false }: MetricCardProps) {
  return (
    <div className="card">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-semibold tabular-nums ${accent ? 'text-emerald-600' : 'text-gray-900'}`}>
        {value}
      </p>
      {subtitle && (
        <p className="text-sm text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  )
}
