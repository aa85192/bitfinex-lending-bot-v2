'use client'

import { useEffect, useState } from 'react'
import { GITHUB_REPO, GITHUB_TOKEN_KEY, getRepoJsonFile, putRepoJsonFile } from '@/lib/github'

const RESERVE_PATH = 'config/reserve-amount.json'
const RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/master/${RESERVE_PATH}`

type Status = 'idle' | 'saving' | 'saved' | 'error'

interface ReserveAmountCardProps {
  currency: string
}

export default function ReserveAmountCard ({ currency }: ReserveAmountCardProps) {
  const [savedValue, setSavedValue] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setStatus('idle')
    fetch(`${RAW_URL}?t=${Date.now()}`, { cache: 'no-store' })
      .then(res => res.ok ? res.json() : Promise.resolve({} as Record<string, number>))
      .then((json: Record<string, number>) => {
        if (cancelled) return
        const v = Number(json?.[currency] ?? 0)
        setSavedValue(v)
        setDraft(String(v))
      })
      .catch(() => {
        if (!cancelled) { setSavedValue(0); setDraft('0') }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [currency])

  const save = async () => {
    const token = localStorage.getItem(GITHUB_TOKEN_KEY) ?? ''
    if (!token) {
      setStatus('error')
      setErrorMsg('請先在上方設定 GitHub PAT')
      return
    }
    const value = Number(draft)
    if (!Number.isFinite(value) || value < 0) {
      setStatus('error')
      setErrorMsg('請輸入不小於 0 的數字')
      return
    }
    setStatus('saving')
    try {
      const { json, sha } = await getRepoJsonFile<Record<string, number>>(RESERVE_PATH, token)
      const next = { ...json, [currency]: value }
      await putRepoJsonFile(RESERVE_PATH, next, sha, token, `chore: set ${currency} reserveAmount to ${value}`)
      setSavedValue(value)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 4000)
    } catch (e: any) {
      setStatus('error')
      setErrorMsg(e.message ?? '儲存失敗')
    }
  }

  const dirty = !loading && savedValue !== null && draft !== '' && Number(draft) !== savedValue

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-medium text-gray-700">保留金額</p>
        {!loading && savedValue !== null && (
          <p className="text-xs text-gray-400">目前 {savedValue} {currency}</p>
        )}
      </div>

      {loading ? (
        <div className="skeleton h-9 w-full" />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-400 leading-relaxed">
            歸還或閒置的資金，扣除保留金額後才會繼續自動出借；未達門檻時暫停借出。
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step="any"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()}
              className="flex-1 text-sm border border-gray-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <button
              onClick={save}
              disabled={status === 'saving' || !dirty}
              className={[
                'text-xs font-medium px-3 py-1.5 rounded-md transition-colors whitespace-nowrap',
                status === 'saving' || !dirty
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700',
              ].join(' ')}
            >
              {status === 'saving' ? '儲存中…' : '儲存'}
            </button>
          </div>
          {status === 'saved' && (
            <p className="text-xs text-emerald-600">已儲存，下次自動掛單執行時生效</p>
          )}
          {status === 'error' && (
            <p className="text-xs text-red-500">{errorMsg}</p>
          )}
        </div>
      )}
    </div>
  )
}
