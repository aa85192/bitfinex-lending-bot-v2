'use client'

interface Props {
  connected: boolean
  wsPublic?: boolean
  wsAuth?: boolean
  lastEventAt?: number
}

export default function LiveBadge ({ connected, wsPublic, wsAuth, lastEventAt }: Props) {
  const allGreen = connected && (wsPublic ?? true) && (wsAuth ?? true)
  const partial = connected && (!wsPublic || !wsAuth)
  const colour = allGreen ? 'bg-emerald-500' : partial ? 'bg-amber-500' : 'bg-rose-500'
  const label = allGreen ? '即時' : partial ? '部分' : '離線'
  const tooltip = lastEventAt
    ? `最近事件 ${new Date(lastEventAt).toLocaleTimeString('zh-Hant')}`
    : '尚未收到事件'

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-gray-500" title={tooltip}>
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colour}`}>
        {allGreen && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${colour} opacity-75 animate-ping`} />
        )}
      </span>
      <span>{label}</span>
    </div>
  )
}
