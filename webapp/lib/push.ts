'use client'

import { type RuntimeConfig, authHeaders } from './config'

export function isPushSupported (): boolean {
  if (typeof window === 'undefined') return false
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isStandalonePwa (): boolean {
  if (typeof window === 'undefined') return false
  const mql = window.matchMedia?.('(display-mode: standalone)')
  return Boolean(mql?.matches) || (window.navigator as any).standalone === true
}

function urlBase64ToUint8Array (base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buffer
}

export async function registerServiceWorker (scope: string): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  const swPath = `${scope.replace(/\/$/, '')}/sw.js`
  return navigator.serviceWorker.register(swPath, { scope })
}

export async function fetchVapidKey (cfg: RuntimeConfig): Promise<string | null> {
  try {
    const res = await fetch(`${cfg.apiBase}/api/config`)
    if (!res.ok) return null
    const data = await res.json()
    return data.vapidPublicKey ?? null
  } catch { return null }
}

export async function getCurrentSubscription (
  reg: ServiceWorkerRegistration,
): Promise<PushSubscription | null> {
  return reg.pushManager.getSubscription()
}

export async function subscribePush (
  reg: ServiceWorkerRegistration,
  vapidPublicKey: string,
  cfg: RuntimeConfig,
): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
  }
  await postSubscription(cfg, sub)
  return sub
}

export async function unsubscribePush (
  reg: ServiceWorkerRegistration,
  cfg: RuntimeConfig,
): Promise<boolean> {
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return false
  try {
    await fetch(`${cfg.apiBase}/api/push/unsubscribe`, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
  } catch { /* server may be down — still unsubscribe locally */ }
  return sub.unsubscribe()
}

async function postSubscription (cfg: RuntimeConfig, sub: PushSubscription): Promise<void> {
  const json = sub.toJSON()
  const res = await fetch(`${cfg.apiBase}/api/push/subscribe`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({
      subscription: {
        endpoint: json.endpoint,
        expirationTime: json.expirationTime ?? null,
        keys: json.keys,
      },
      ua: navigator.userAgent,
    }),
  })
  if (!res.ok) throw new Error(`subscribe failed: HTTP ${res.status}`)
}

export async function sendTestPush (cfg: RuntimeConfig): Promise<{ sent: number, removed: number }> {
  const res = await fetch(`${cfg.apiBase}/api/push/test`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`test push failed: HTTP ${res.status}`)
  return res.json()
}
