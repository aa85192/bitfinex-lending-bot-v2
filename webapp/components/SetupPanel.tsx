'use client'

import { useState } from 'react'
import { setRuntimeConfig } from '@/lib/config'

interface Props {
  initialApiBase?: string
  initialViewerToken?: string
  onSaved: () => void
}

export default function SetupPanel ({ initialApiBase = '', initialViewerToken = '', onSaved }: Props) {
  const [apiBase, setApiBase] = useState(initialApiBase)
  const [viewerToken, setViewerToken] = useState(initialViewerToken)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const test = async () => {
    setError(null); setOk(null); setTesting(true)
    try {
      const base = apiBase.replace(/\/$/, '')
      const url = viewerToken
        ? `${base}/api/health?token=${encodeURIComponent(viewerToken)}`
        : `${base}/api/health`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data?.ok) throw new Error('server did not return ok')
      setOk('連線成功 ✓')
    } catch (e: any) {
      setError(`連線失敗: ${e.message ?? e}`)
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    setRuntimeConfig({ apiBase: apiBase.trim(), viewerToken: viewerToken.trim() })
    onSaved()
  }

  return (
    <div className="card max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">設定 Bot 連線</h2>
        <p className="text-sm text-gray-500 mt-1">
          填入你 GCP VM 上跑的 Bot API 位址。安裝完成後,腳本會印出 URL。
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">API URL</label>
        <input
          type="url"
          inputMode="url"
          value={apiBase}
          onChange={e => setApiBase(e.target.value)}
          placeholder="https://1-2-3-4.sslip.io"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">Viewer Token (選填)</label>
        <input
          type="password"
          value={viewerToken}
          onChange={e => setViewerToken(e.target.value)}
          placeholder="若 Bot 設定了 VIEWER_TOKEN 才需要填"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-600">{error}</div>}
      {ok && <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <div className="flex items-center gap-2">
        <button
          onClick={test}
          disabled={!apiBase || testing}
          className="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
        >
          {testing ? '測試中…' : '測試連線'}
        </button>
        <button
          onClick={save}
          disabled={!apiBase}
          className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          儲存並使用
        </button>
      </div>
    </div>
  )
}
