'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  fetchVapidKey,
  getCurrentSubscription,
  isPushSupported,
  isStandalonePwa,
  registerServiceWorker,
  sendTestPush,
  subscribePush,
  unsubscribePush,
} from '@/lib/push'
import { type RuntimeConfig } from '@/lib/config'

interface Props {
  cfg: RuntimeConfig
  scope: string
}

type Status = 'unknown' | 'unsupported' | 'denied' | 'off' | 'on'

export default function NotificationButton ({ cfg, scope }: Props) {
  const [status, setStatus] = useState<Status>('unknown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsPwa, setNeedsPwa] = useState(false)
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null)

  const detect = useCallback(async () => {
    if (!isPushSupported()) { setStatus('unsupported'); return }
    if (Notification.permission === 'denied') { setStatus('denied'); return }

    // iOS only allows Push from installed PWAs (16.4+).
    const ua = navigator.userAgent
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream
    if (isIOS && !isStandalonePwa()) {
      setNeedsPwa(true)
      setStatus('off')
      return
    }

    const r = await registerServiceWorker(scope)
    setReg(r)
    if (!r) { setStatus('unsupported'); return }

    await navigator.serviceWorker.ready
    const sub = await getCurrentSubscription(r)
    setStatus(sub ? 'on' : 'off')
  }, [scope])

  useEffect(() => { detect().catch(e => setError(e.message)) }, [detect])

  const enable = async () => {
    if (!reg) return
    setBusy(true); setError(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off')
        return
      }
      const vapidKey = await fetchVapidKey(cfg)
      if (!vapidKey) throw new Error('無法取得 VAPID 公鑰,請檢查 Bot 連線')
      await subscribePush(reg, vapidKey, cfg)
      setStatus('on')
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!reg) return
    setBusy(true); setError(null)
    try {
      await unsubscribePush(reg, cfg)
      setStatus('off')
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true); setError(null)
    try {
      const r = await sendTestPush(cfg)
      if (r.sent === 0) setError('沒有任何訂閱裝置')
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'unknown') return null

  if (status === 'unsupported') {
    return <div className="text-xs text-gray-400">此瀏覽器不支援推播</div>
  }

  if (status === 'denied') {
    return <div className="text-xs text-rose-500">推播權限被拒,請至瀏覽器設定開啟</div>
  }

  if (needsPwa) {
    return (
      <div className="text-xs text-amber-600 max-w-xs">
        iOS 須將此網頁<strong>加入主畫面</strong>後開啟,才能啟用推播通知
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      {status === 'off' && (
        <button
          onClick={enable}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? '處理中…' : '啟用通知'}
        </button>
      )}
      {status === 'on' && (
        <>
          <button
            onClick={test}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            測試
          </button>
          <button
            onClick={disable}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
          >
            關閉通知
          </button>
        </>
      )}
      {error && <span className="text-rose-500">{error}</span>}
    </div>
  )
}
