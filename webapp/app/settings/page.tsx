'use client'

import { useState, useEffect } from 'react'
import { getSupabaseClient } from '@/lib/supabase'

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

const DEFAULT_SETTINGS: Settings = {
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
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const supabase = getSupabaseClient()
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .eq('user_id', 'wtkuo')
        .single()

      if (error && error.code !== 'PGRST116') throw error
      if (data) setSettings(data)
    } catch (error) {
      console.error('載入設定失敗:', error)
      setMessage('載入設定失敗')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    try {
      const supabase = getSupabaseClient()
      const { error } = await supabase
        .from('settings')
        .upsert({
          user_id: 'wtkuo',
          ...settings,
          updated_at: new Date().toISOString()
        })

      if (error) throw error
      setMessage('設定已保存')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      console.error('保存失敗:', error)
      setMessage('保存失敗: ' + error)
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8 flex items-center justify-center">
        <p className="text-white text-lg">載入中...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-8">放貸設定</h1>

        {message && (
          <div className="mb-6 p-4 rounded-lg bg-slate-700 text-white text-center">
            {message}
          </div>
        )}

        {/* USD 設定 */}
        <CurrencySection
          title="USD"
          enabled={settings.usd_enabled}
          minAmount={settings.usd_min_amount}
          maxAmount={settings.usd_max_amount}
          rateMin={settings.usd_rate_min}
          rateMax={settings.usd_rate_max}
          rank={settings.usd_rank}
          onChange={(field, value) => setSettings({ ...settings, [`usd_${field}`]: value })}
        />

        {/* USDT 設定 */}
        <CurrencySection
          title="USDT"
          enabled={settings.usdt_enabled}
          minAmount={settings.usdt_min_amount}
          maxAmount={settings.usdt_max_amount}
          rateMin={settings.usdt_rate_min}
          rateMax={settings.usdt_rate_max}
          rank={settings.usdt_rank}
          onChange={(field, value) => setSettings({ ...settings, [`usdt_${field}`]: value })}
        />

        {/* API 設定 */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg mb-6">
          <h2 className="text-2xl font-semibold text-white mb-6">API 金鑰</h2>
          <div className="space-y-4">
            <InputField
              label="Bitfinex API Key"
              type="password"
              placeholder="輸入你的 API Key"
              value={settings.bitfinex_api_key}
              onChange={(v) => setSettings({ ...settings, bitfinex_api_key: v })}
            />
            <InputField
              label="Bitfinex API Secret"
              type="password"
              placeholder="輸入你的 API Secret"
              value={settings.bitfinex_api_secret}
              onChange={(v) => setSettings({ ...settings, bitfinex_api_secret: v })}
            />
            <InputField
              label="Telegram Token"
              type="password"
              placeholder="輸入你的 Telegram Bot Token"
              value={settings.telegram_token}
              onChange={(v) => setSettings({ ...settings, telegram_token: v })}
            />
            <InputField
              label="Telegram Chat ID"
              type="text"
              placeholder="輸入你的 Telegram Chat ID"
              value={settings.telegram_chat_id}
              onChange={(v) => setSettings({ ...settings, telegram_chat_id: v })}
            />
          </div>
        </div>

        {/* 保存按鈕 */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-600 disabled:to-gray-600 px-6 py-3 rounded-lg font-semibold text-white text-lg transition-all"
        >
          {saving ? '保存中...' : '保存設定'}
        </button>
      </div>
    </div>
  )
}

function CurrencySection({ title, enabled, minAmount, maxAmount, rateMin, rateMax, rank, onChange }: {
  title: string
  enabled: boolean
  minAmount: number
  maxAmount: number
  rateMin: number
  rateMax: number
  rank: number
  onChange: (field: string, value: number | boolean) => void
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 p-6 rounded-lg mb-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold text-white">{title}</h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange('enabled', e.target.checked)}
            className="w-6 h-6 accent-blue-500"
          />
          <span className="text-white font-medium">
            {enabled ? '啟用' : '停用'}
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumberField label="最小金額" step="0.01" value={minAmount} onChange={(v) => onChange('min_amount', v)} />
        <NumberField label="最大金額" step="0.01" value={maxAmount} onChange={(v) => onChange('max_amount', v)} />
        <NumberField label="最小利率" step="0.000001" value={rateMin} onChange={(v) => onChange('rate_min', v)} />
        <NumberField label="最大利率" step="0.000001" value={rateMax} onChange={(v) => onChange('rate_max', v)} />
        <div className="md:col-span-2">
          <NumberField label="排名百分位 (Rank)" step="0.01" value={rank} onChange={(v) => onChange('rank', v)} />
          <p className="text-xs text-gray-500 mt-1">0 = 最低利率, 1 = 最高利率, 0.8 = 80%</p>
        </div>
      </div>
    </div>
  )
}

function NumberField({ label, step, value, onChange }: {
  label: string; step: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="text-sm text-gray-400">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
      />
    </div>
  )
}

function InputField({ label, type, placeholder, value, onChange }: {
  label: string; type: string; placeholder: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="text-sm text-gray-400">{label}</label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
      />
    </div>
  )
}
