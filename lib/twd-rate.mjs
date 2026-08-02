/*
取得美元兌台幣匯率，讓 webapp 可以把 USD 金額換算成台幣顯示。

優先抓臺灣銀行牌告匯率的「即期買入」——把手上的美元換回台幣時銀行給的價格，
最貼近「這些錢等於多少台幣」。但 rate.bot.com.tw 對程式化存取會回一個需要跑
JavaScript 的驗證頁（Challenge Validation），排程環境多半過不了，因此取不到或
解析不出來時會自動改用公開匯率 API，並在結果標記實際來源。
*/

const BOT_CSV_URL = 'https://rate.bot.com.tw/xrt/flcsv/0/day'
const FALLBACK_URL = 'https://open.er-api.com/v6/latest/USD'

// 美元兌台幣長年落在此區間，超出範圍視為解析錯誤而非真實匯率
const RATE_MIN = 20
const RATE_MAX = 50

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function isSaneRate (n) {
  return Number.isFinite(n) && n >= RATE_MIN && n <= RATE_MAX
}

async function fetchWithTimeout (url, timeoutMs = 10000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'zh-TW,zh;q=0.9',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

/**
 * 解析臺灣銀行 flcsv：每列是「幣別,標籤,數值,標籤,數值,...」。
 * 以標籤定位而非固定欄位順序，欄位增減時比較不會壞；買入即期的標籤含 SPOT，
 * 退而求其次用買入現金（含 BUY）。任何一步對不上就丟出錯誤讓呼叫端走備援。
 */
export function parseBotCsv (csv) {
  if (/<html|Challenge Validation/i.test(csv)) {
    throw new Error('rate.bot.com.tw 回應驗證頁，無法程式化取得')
  }

  const line = csv.split(/\r?\n/).find(l => /^USD\b/i.test(l.trim()))
  if (line == null) throw new Error('CSV 中找不到 USD 匯率')

  const fields = line.split(',').map(s => s.trim())
  const pairs = []
  for (let i = 1; i < fields.length - 1; i++) {
    const value = Number(fields[i + 1])
    if (/^[A-Za-z]/.test(fields[i]) && Number.isFinite(value)) pairs.push([fields[i].toUpperCase(), value])
  }

  // 買入（B 開頭）的即期優先，其次買入現金
  const spot = pairs.find(([label]) => label.startsWith('B') && label.includes('SPOT'))
  const cash = pairs.find(([label]) => label.startsWith('B') && label.includes('BUY'))
  const picked = [spot, cash].find(p => p != null && isSaneRate(p[1]))
  if (picked == null) throw new Error('CSV 中找不到合理的 USD 買入匯率')

  return picked[1]
}

async function fetchFromBot () {
  const csv = await fetchWithTimeout(BOT_CSV_URL)
  return parseBotCsv(await csv.text())
}

async function fetchFromFallback () {
  const res = await fetchWithTimeout(FALLBACK_URL)
  const json = await res.json()
  const rate = Number(json?.rates?.TWD)
  if (!isSaneRate(rate)) throw new Error('備援匯率 API 未回傳合理的 TWD 匯率')
  return rate
}

/**
 * 回傳 { rate, source, fetchedAt }；兩個來源都失敗時回傳 null，
 * 呼叫端應把台幣換算視為選配資訊，不要讓它影響主要流程。
 */
export async function fetchTwdRate () {
  const sources = [
    ['bot', fetchFromBot],
    ['fallback', fetchFromFallback],
  ]

  for (const [source, fn] of sources) {
    try {
      const rate = await fn()
      return { rate, source, fetchedAt: new Date().toISOString() }
    } catch (err) {
      console.warn(`[twd-rate] ${source} 取得匯率失敗：${err?.message ?? err}`)
    }
  }
  return null
}
