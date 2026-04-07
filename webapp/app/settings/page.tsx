'use client'

import { useState, useEffect } from 'react'

interface Settings {
  user_id?: string
  usd_enabled: boolean
  usd_min_amount: number
  usd_max_amount: number
  usd_rate_min: number
  usd_rate_max: number
  usd_rank: number
  usdt_enabled: boolean
  usdt_min_amount: number
  usdt_max_amount: number
  usdt_rate_min: number
  usdt_rate_max: number
  usdt_rank: number
  bitfinex_api_key: string
  bitfinex_api_secret: string
  telegram_token: string
  telegram_chat_id: string
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    usd_enabled: true,
    usd_min_amount: 150,
    usd_max_amount: 10000,
    usd_rate_min: 0.0001,
    usd_rate_max: 0.01,
    usd_rank: 0.8,
    usdt_enabled: true,
    usdt_min_amount: 150,
    usdt_max_amount: 10000,
    usdt_rate_min: 0.0001,
    usdt_rate_max: 0.01,
    usdt_rank: 0.8,
    bitfinex_api_key: '',
    bitfinex_api_secret: '',
    telegram_token: '',
    telegram_chat_id: ''
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch('/api/settings')
      const data = await response.json()
      setSettings(data)
    } catch (error) {
      setMessage('載入設定失敗')
      console.error(error)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
      const result = await response.json()
      setMessage('✅ 設定已保存')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      setMessage('❌ 保存失敗: ' + error)
      console.error(error)
    }
    setSaving(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-8">⚙️ 放貸設定</h1>

        {message && (
          <div className="mb-6 p-4 rounded-lg bg-slate-700 text-white text-center">
            {message}
          </div>
        )}

        {/* USD 設定 */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg mb-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-semibold text-white">USD</h2>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.usd_enabled}
                onChange={(e) =>
                  setSettings({ ...settings, usd_enabled: e.target.checked })
                }
                className="w-6 h-6 accent-blue-500"
              />
              <span className="text-white font-medium">
                {settings.usd_enabled ? '✅ 啟用' : '❌ 停用'}
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-gray-400">最小金額</label>
              <input
                type="number"
                step="0.01"
                value={settings.usd_min_amount}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usd_min_amount: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最大金額</label>
              <input
                type="number"
                step="0.01"
                value={settings.usd_max_amount}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usd_max_amount: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最小利率</label>
              <input
                type="number"
                step="0.000001"
                value={settings.usd_rate_min}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usd_rate_min: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最大利率</label>
              <input
                type="number"
                step="0.000001"
                value={settings.usd_rate_max}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usd_rate_max: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-sm text-gray-400">排名百分位 (Rank)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={settings.usd_rank}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usd_rank: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">0 = 最低利率, 1 = 最高利率, 0.8 = 80%</p>
            </div>
          </div>
        </div>

        {/* USDT 設定 */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg mb-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-semibold text-white">USDT</h2>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.usdt_enabled}
                onChange={(e) =>
                  setSettings({ ...settings, usdt_enabled: e.target.checked })
                }
                className="w-6 h-6 accent-blue-500"
              />
              <span className="text-white font-medium">
                {settings.usdt_enabled ? '✅ 啟用' : '❌ 停用'}
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-gray-400">最小金額</label>
              <input
                type="number"
                step="0.01"
                value={settings.usdt_min_amount}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usdt_min_amount: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最大金額</label>
              <input
                type="number"
                step="0.01"
                value={settings.usdt_max_amount}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usdt_max_amount: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最小利率</label>
              <input
                type="number"
                step="0.000001"
                value={settings.usdt_rate_min}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usdt_rate_min: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">最大利率</label>
              <input
                type="number"
                step="0.000001"
                value={settings.usdt_rate_max}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usdt_rate_max: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-sm text-gray-400">排名百分位 (Rank)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={settings.usdt_rank}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    usdt_rank: parseFloat(e.target.value)
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">0 = 最低利率, 1 = 最高利率, 0.8 = 80%</p>
            </div>
          </div>
        </div>

        {/* API 設定 */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg mb-6">
          <h2 className="text-2xl font-semibold text-white mb-6">🔑 API 金鑰</h2>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-400">Bitfinex API Key</label>
              <input
                type="password"
                placeholder="输入你的 API Key"
                value={settings.bitfinex_api_key}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    bitfinex_api_key: e.target.value
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">Bitfinex API Secret</label>
              <input
                type="password"
                placeholder="输入你的 API Secret"
                value={settings.bitfinex_api_secret}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    bitfinex_api_secret: e.target.value
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">Telegram Token</label>
              <input
                type="password"
                placeholder="输入你的 Telegram Bot Token"
                value={settings.telegram_token}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    telegram_token: e.target.value
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">Telegram Chat ID</label>
              <input
                type="text"
                placeholder="输入你的 Telegram Chat ID"
                value={settings.telegram_chat_id}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    telegram_chat_id: e.target.value
                  })
                }
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
              />
            </div>
          </div>
        </div>

        {/* 保存按鈕 */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-600 disabled:to-gray-600 px-6 py-3 rounded-lg font-semibold text-white text-lg transition-all"
        >
          {saving ? '🔄 保存中...' : '💾 保存設定'}
        </button>
      </div>
    </div>
  )
}
