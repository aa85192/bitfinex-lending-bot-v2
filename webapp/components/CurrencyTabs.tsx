'use client'

const CURRENCIES = ['USD', 'UST']

interface CurrencyTabsProps {
  active: string
  onChange: (currency: string) => void
}

export default function CurrencyTabs({ active, onChange }: CurrencyTabsProps) {
  return (
    <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
      {CURRENCIES.map(c => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-all ${
            active === c
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  )
}
