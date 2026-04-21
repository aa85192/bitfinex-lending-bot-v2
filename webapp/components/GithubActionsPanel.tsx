'use client'

import { useEffect, useRef, useState } from 'react'

const REPO = 'aa85192/bitfinex-lending-bot-v2'
const TOKEN_KEY = 'github_pat'

const WORKFLOWS = [
  { id: 'gh-pages.yml', label: '狀態更新', desc: '匯出目前狀態 (~1 分鐘)' },
  { id: 'wtkuo-auto-renew-3.yml', label: '自動掛單', desc: '重新計算利率並掛單 (~2 分鐘)' },
] as const

type WorkflowId = typeof WORKFLOWS[number]['id']
type TriggerStatus = 'idle' | 'loading' | 'success' | 'error'

async function dispatchWorkflow (workflowId: string, token: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'master' }),
    }
  )
  if (res.status !== 204) {
    const msg = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${msg ? ': ' + msg : ''}`)
  }
}

export default function GithubActionsPanel () {
  const [token, setToken] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [draft, setDraft] = useState('')
  const [statuses, setStatuses] = useState<Record<WorkflowId, TriggerStatus>>({
    'gh-pages.yml': 'idle',
    'wtkuo-auto-renew-3.yml': 'idle',
  })
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY) ?? ''
    setToken(saved)
    setDraft(saved)
  }, [])

  const saveToken = () => {
    const t = draft.trim()
    setToken(t)
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
    setShowInput(false)
  }

  const trigger = async (workflowId: WorkflowId) => {
    if (!token || statuses[workflowId] === 'loading') return
    setStatuses(s => ({ ...s, [workflowId]: 'loading' }))
    clearTimeout(timers.current[workflowId])
    try {
      await dispatchWorkflow(workflowId, token)
      setStatuses(s => ({ ...s, [workflowId]: 'success' }))
    } catch {
      setStatuses(s => ({ ...s, [workflowId]: 'error' }))
    }
    timers.current[workflowId] = setTimeout(
      () => setStatuses(s => ({ ...s, [workflowId]: 'idle' })),
      6000
    )
  }

  return (
    <div className="card py-3 px-4 flex flex-wrap items-center gap-3">
      {/* Token 設定 */}
      <div className="flex items-center gap-2 mr-1">
        <span className="text-xs text-gray-500 font-medium whitespace-nowrap">GitHub PAT</span>
        {showInput ? (
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveToken()}
              placeholder="ghp_..."
              className="text-xs border border-gray-200 rounded-md px-2 py-1 w-44 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              autoFocus
            />
            <button
              onClick={saveToken}
              className="text-xs px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              儲存
            </button>
            <button
              onClick={() => { setDraft(token); setShowInput(false) }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowInput(true)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            title="設定 GitHub Personal Access Token（需要 workflow 權限）"
          >
            {token ? (
              <span className="font-mono text-gray-500">{'·'.repeat(8)}</span>
            ) : (
              <span className="text-amber-500">未設定</span>
            )}
            <svg className="w-3 h-3 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
            </svg>
          </button>
        )}
      </div>

      <div className="w-px h-5 bg-gray-200 hidden sm:block" />

      {/* Workflow 觸發按鈕 */}
      {WORKFLOWS.map(({ id, label, desc }) => {
        const st = statuses[id]
        const disabled = !token || st === 'loading'
        return (
          <button
            key={id}
            onClick={() => trigger(id)}
            disabled={disabled}
            title={!token ? '請先設定 GitHub PAT' : desc}
            className={[
              'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors',
              disabled
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : st === 'success'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : st === 'error'
                    ? 'bg-red-50 text-red-600 border border-red-200'
                    : 'bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100',
            ].join(' ')}
          >
            {st === 'loading' ? (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : st === 'success' ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : st === 'error' ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
            )}
            {st === 'loading' ? '觸發中…' : st === 'success' ? '已觸發' : st === 'error' ? '失敗' : `觸發 ${label}`}
          </button>
        )
      })}

      {Object.values(statuses).some(s => s === 'success') && (
        <span className="text-xs text-gray-400 ml-1">等待 1~2 分鐘後按重整</span>
      )}
    </div>
  )
}
