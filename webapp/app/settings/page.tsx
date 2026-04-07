'use client'

import { useState, useEffect } from 'react'
import { getSupabaseClient } from '@/lib/supabase'
import { Session } from '@supabase/supabase-js'

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
}

export default function SettingsPage() {
  const [session, setSession] = useState<Session | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  useEffect(() => {
    checkAuth()
  }, [])

  const checkAuth = async () => {
    try {
      const supabase = getSupabaseClient()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      setSession(session)

      if (session?.user) {
        loadSettings()
      }
    } catch (error) {
      console.error('檢查登入狀態失敗:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthLoading(true)
    setMessage('')

    try {
      const supabase = getSupabaseClient()

      if (authMode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (error) throw error
        setMessage('✅ 登入成功')
        setEmail('')
        setPassword('')
        await checkAuth()
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        })
        if (error) throw error
        setMessage('✅ 註冊成功，請檢查信箱驗證')
        setEmail('')
        setPassword('')
      }
    } catch (error) {
      setMessage(`❌ ${error}`)
    }
    setAuthLoading(false)
  }

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
          updated_at: new Date().toISOString(),
        })

      if (error) throw error
      setMessage('✅ 設定已保存')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      console.error('保存失敗:', error)
      setMessage('❌ 保存失敗: ' + error)
    }
    setSaving(false)
  }

  const handleLogout = async () => {
    try {
      const supabase = getSupabaseClient()
      await supabase.auth.signOut()
      setSession(null)
      setSettings(DEFAULT_SETTINGS)
      setMessage('已登出')
    } catch (error) {
      setMessage('❌ 登出失敗')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8 flex items-center justify-center">
        <p className="text-white text-lg">載入中...</p>
      </div>
    )
  }

  // 未登入 - 顯示登入頁面
  if (!session?.user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8 flex items-center justify-center">
        <div className="max-w-md w-full bg-slate-800 border border-slate-700 p-8 rounded-lg">
          <h1 className="text-3xl font-bold text-white mb-8 text-center">
            🔐 設定管理
          </h1>

          {message && (
            <div className="mb-6 p-4 rounded-lg bg-slate-700 text-white text-center text-sm">
              {message}
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="text-sm text-gray-400">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
                required
              />
            </div>

            <div>
              <label className="text-sm text-gray-400">密碼</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full mt-2 bg-slate-700 px-4 py-2 rounded text-white border border-slate-600 focus:border-blue-500 outline-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-6 py-2 rounded-lg font-semibold text-white transition-all"
            >
              {authLoading ? '處理中...' : authMode === 'login' ? '登入' : '註冊'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-gray-400 text-sm">
              {authMode === 'login' ? '還沒有帳號？' : '已有帳號？'}
              <button
                onClick={() => {
                  setAuthMode(authMode === 'login' ? 'signup' : 'login')
                  setMessage('')
                  setEmail('')
                  setPassword('')
                }}
                className="ml-2 text-blue-400 hover:text-blue-300 font-semibold"
              >
                {authMode === 'login' ? '前往註冊' : '返回登入'}
              </button>
            </p>
          </div>
        </div>
      </div>
    )
  }

  // 已登入 - 顯示設定頁面
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-4xl font-bold text-white">⚙️ 放貸設定</h1>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm"
          >
            登出 ({session.user.email})
          </button>
        </div>

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
          onChange={(field, value) =>
            setSettings({ ...settings, [`usd_${field}`]: value })
          }
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
          onChange={(field, value) =>
            setSettings({ ...settings, [`usdt_${field}`]: value })
          }
        />

        {/* 保存按鈕 */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-600 disabled:to-gray-600 px-6 py-3 rounded-lg font-semibold text-white text-lg transition-all"
        >
          {saving ? '保存中...' : '💾 保存設定'}
        </button>
      </div>
    </div>
  )
}

function CurrencySection({
  title,
  enabled,
  minAmount,
  maxAmount,
  rateMin,
  rateMax,
  rank,
  onChange,
}: {
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
            {enabled ? '✅ 啟用' : '❌ 停用'}
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumberField
          label="最小金額"
          step="0.01"
          value={minAmount}
          onChange={(v) => onChange('min_amount', v)}
        />
        <NumberField
          label="最大金額"
          step="0.01"
          value={maxAmount}
          onChange={(v) => onChange('max_amount', v)}
        />
        <NumberField
          label="最小利率"
          step="0.000001"
          value={rateMin}
          onChange={(v) => onChange('rate_min', v)}
        />
        <NumberField
          label="最大利率"
          step="0.000001"
          value={rateMax}
          onChange={(v) => onChange('rate_max', v)}
        />
        <div className="md:col-span-2">
          <NumberField
            label="排名百分位 (Rank)"
            step="0.01"
            value={rank}
            onChange={(v) => onChange('rank', v)}
          />
          <p className="text-xs text-gray-500 mt-1">
            0 = 最低利率, 1 = 最高利率, 0.8 = 80%
          </p>
        </div>
      </div>
    </div>
  )
}

function NumberField({
  label,
  step,
  value,
  onChange,
}: {
  label: string
  step: string
  value: number
  onChange: (v: number) => void
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
