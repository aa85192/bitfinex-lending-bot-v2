export const GITHUB_REPO = 'aa85192/bitfinex-lending-bot-v2'
export const GITHUB_BRANCH = 'master'
export const GITHUB_TOKEN_KEY = 'github_pat'

function authHeaders (token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** 讀取 repo 內某個 JSON 檔案的內容與 sha（更新時需要用 sha 避免覆蓋他人變更） */
export async function getRepoJsonFile<T = any> (path: string, token: string): Promise<{ json: T; sha: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { headers: authHeaders(token), cache: 'no-store' }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const text = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))
  return { json: JSON.parse(text), sha: data.sha }
}

/** 寫入 repo 內某個 JSON 檔案（直接 commit 到 GITHUB_BRANCH） */
export async function putRepoJsonFile (path: string, json: unknown, sha: string, token: string, message: string): Promise<void> {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(json, null, 2) + '\n')))
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content, sha, branch: GITHUB_BRANCH }),
    }
  )
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${msg ? ': ' + msg : ''}`)
  }
}
