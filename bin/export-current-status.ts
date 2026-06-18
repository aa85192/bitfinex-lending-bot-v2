/*
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/export-current-status.ts

匯出目前放貸狀態到 dist/current-status/{currency}.json
供 GitHub Pages webapp 讀取（注意：此為公開資料）
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, PlatformStatus } from '@taichunmin/bitfinex'
import { rest } from '../lib/bitfinex.mjs'
import { promises as fsPromises } from 'node:fs'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

async function withNonceRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const msg = String(err?.message ?? '')
      const isNonce = msg.includes('10114') || msg.toLowerCase().includes('nonce')
      if (isNonce && attempt < maxRetries - 1) {
        const delay = (attempt + 1) * 4000 + Math.random() * 2000
        console.warn(`[export-current-status] nonce conflict, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 2}/${maxRetries})`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('unreachable')
}

const outdir = new URL('../dist/current-status/', import.meta.url)
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

async function main (): Promise<void> {
  const apiKey = getenv('BITFINEX_API_KEY')
  if (!apiKey) throw new Error('BITFINEX_API_KEY 未設定')

  const currencys = getenv('INPUT_CURRENCYS', 'USD,UST')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)

  if (currencys.length === 0) throw new Error('INPUT_CURRENCYS 未設定')

  const platformStatus = await Bitfinex.v2PlatformStatus()
  if (platformStatus.status === PlatformStatus.MAINTENANCE) {
    throw new Error('Bitfinex API is in maintenance mode')
  }

  const wallets = await withNonceRetry(() => bitfinex.v2AuthReadWallets())

  let hasError = false
  for (const currency of currencys) {
    try {
      // 循序呼叫避免 nonce 衝突
      // Bitfinex 把已媒合的出借拆成 credits（使用中）與 loans（已媒合未使用），兩者皆為實際出借中
      // 並計息，需合併才不會少算。@taichunmin client 未提供 loans，改用 RESTv2（rest）讀取。
      const credits = await withNonceRetry(() => bitfinex.v2AuthReadFundingCredits({ currency }))
      const loans = await withNonceRetry(() => rest.fundingLoans({ symbol: `f${currency}` })).catch(() => [])
      const offers = await withNonceRetry(() => bitfinex.v2AuthReadFundingOffers({ currency }))
      const autoRenew = await withNonceRetry(() => bitfinex.v2AuthReadFundingAutoStatus({ currency })).catch(() => null)

      const fundingWallet = (wallets as any[]).find(
        (w: any) => w.type === 'funding' && w.currency === currency
      )

      const toIso = (v: any): string | null => {
        const ms = v instanceof Date ? v.getTime() : Number(v)
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
      }
      // credits 與 loans 欄位一致（id/side/amount/rate/period/mtsOpening/mtsLastPayout），共用對應
      const mapLending = (x: any) => ({
        id: x.id,
        amount: Math.abs(x.amount),
        rate: x.rate,
        period: x.period,
        mtsOpening: toIso(x.mtsOpening ?? x.mtsCreate) ?? new Date().toISOString(),
        mtsLastPayout: toIso(x.mtsLastPayout),
      })
      const creditsList = (credits as any[]).filter((c: any) => c.side === 1)
      const loansList = (loans as any[]).filter((l: any) => l.side === 1)
      // 出借明細 = 使用中（credits）+ 已媒合未使用（loans），合併呈現完整出借部位
      const creditsData = [...creditsList, ...loansList].map(mapLending)
      const offersData = (offers as any[]).map((o: any) => ({
        id: o.id,
        amount: Math.abs(o.amount),
        rate: o.rate,
        period: o.period,
      }))

      // 投資總額用 Bitfinex 真實總餘額（wallet.balance），可用餘額用真實 availableBalance，
      // 兩者皆直接取自錢包，避免回推失真；已借出 = credits + loans 已可對齊總餘額。
      const availableBalance = (fundingWallet as any)?.availableBalance ?? 0

      const data = {
        wallet: {
          balance: (fundingWallet as any)?.balance ?? 0,
          availableBalance,
        },
        credits: creditsData,
        offers: offersData,
        autoRenew: autoRenew != null
          ? {
              rate: (autoRenew as any).rate ?? 0,
              period: (autoRenew as any).period ?? 0,
              amount: (autoRenew as any).amount ?? 0,
            }
          : null,
        updatedAt: new Date().toISOString(),
      }

      // 生成非压缩和压缩版本（GitHub Pages 会自动使用合适的版本）
      const jsonStr = JSON.stringify(data)
      await Promise.all([
        writeFile(new URL(`${currency}.json`, outdir), jsonStr),
        writeFileGz(new URL(`${currency}.json.gz`, outdir), jsonStr),
      ])
      console.log(`[export-current-status] ✓ ${currency}: balance=${data.wallet.balance}, available=${data.wallet.availableBalance}, lending=${data.credits.length} (credits=${creditsList.length}+loans=${loansList.length}), offers=${data.offers.length}`)
    } catch (err) {
      console.error(`[export-current-status] ✗ ${currency} failed:`, err)
      hasError = true
    }
  }

  if (hasError) throw new Error('部分幣種匯出失敗，請檢查上方錯誤')
}

async function writeFile (filepath: URL, data: string): Promise<void> {
  await fsPromises.mkdir(new URL('.', filepath), { recursive: true })
  await fsPromises.writeFile(filepath, data)
}

async function writeFileGz (filepath: URL, data: string): Promise<void> {
  await fsPromises.mkdir(new URL('.', filepath), { recursive: true })
  const compressed = await gzipAsync(data)
  await fsPromises.writeFile(filepath, compressed)
}

main().catch(err => {
  console.error('[export-current-status] Fatal error:', err)
  process.exit(1)
})
