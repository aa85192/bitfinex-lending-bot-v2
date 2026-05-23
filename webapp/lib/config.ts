'use client'

// Runtime config — stored in localStorage so users can point the static site
// at their own GCP-hosted bot without rebuilding.
//
// Reads NEXT_PUBLIC_API_BASE / NEXT_PUBLIC_VIEWER_TOKEN as defaults at build time.

const KEY_API_BASE = 'lendingbot.apiBase'
const KEY_VIEWER_TOKEN = 'lendingbot.viewerToken'

export interface RuntimeConfig {
  apiBase: string
  viewerToken: string
}

export function getRuntimeConfig (): RuntimeConfig | null {
  if (typeof window === 'undefined') return null
  const apiBase =
    window.localStorage.getItem(KEY_API_BASE) ??
    (process.env.NEXT_PUBLIC_API_BASE ?? '')
  const viewerToken =
    window.localStorage.getItem(KEY_VIEWER_TOKEN) ??
    (process.env.NEXT_PUBLIC_VIEWER_TOKEN ?? '')

  if (!apiBase) return null
  return { apiBase: apiBase.replace(/\/$/, ''), viewerToken }
}

export function setRuntimeConfig (cfg: RuntimeConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY_API_BASE, cfg.apiBase.replace(/\/$/, ''))
  if (cfg.viewerToken) window.localStorage.setItem(KEY_VIEWER_TOKEN, cfg.viewerToken)
  else window.localStorage.removeItem(KEY_VIEWER_TOKEN)
}

export function clearRuntimeConfig (): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY_API_BASE)
  window.localStorage.removeItem(KEY_VIEWER_TOKEN)
}

export function authHeaders (cfg: RuntimeConfig | null): HeadersInit {
  if (!cfg?.viewerToken) return { 'Content-Type': 'application/json' }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.viewerToken}`,
  }
}

export function withAuthQuery (url: string, cfg: RuntimeConfig | null): string {
  if (!cfg?.viewerToken) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(cfg.viewerToken)}`
}
