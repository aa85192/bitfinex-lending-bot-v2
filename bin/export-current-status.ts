/*
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/export-current-status.ts

匯出目前放貸狀態到 dist/current-status/{currency}.json
供 GitHub Pages webapp 讀取（注意：此為公開資料）
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { promises as fsPromises } from 'node:fs'
import * as url from 'node:url'
import { createLoggersByUrl } from '../lib/logger.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const outdir = new URL('../dist/current-status/', import.meta.url)
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

export async function main (): Promise<void> {
  const currencys = getenv('INPUT_CURRENCYS', 'USD,UST')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)

  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  const wallets = await bitfinex.v2AuthReadWallets()

  for (const currency of currencys) {
    try {
      const [credits, offers, autoRenew] = await Promise.all([
        bitfinex.v2AuthReadFundingCredits({ currency }),
        bitfinex.v2AuthReadFundingOffers({ currency }),
        bitfinex.v2AuthReadFundingAutoStatus({ currency }).catch(() => null),
      ])

      const fundingWallet = (wallets as any[]).find(
        (w: any) => w.type === 'funding' && w.currency === currency
      )

      const data = {
        wallet: {
          balance: fundingWallet?.balance ?? 0,
        },
        credits: (credits as any[])
          .filter((c: any) => c.side === 1)
          .map((c: any) => ({
            id: c.id,
            amount: Math.abs(c.amount),
            rate: c.rate,
            period: c.period,
            mtsOpening: (c.mtsOpening instanceof Date ? c.mtsOpening : new Date(c.mtsOpening)).toISOString(),
            mtsLastPayout: c.mtsLastPayout
              ? (c.mtsLastPayout instanceof Date ? c.mtsLastPayout : new Date(c.mtsLastPayout)).toISOString()
              : null,
          })),
        offers: (offers as any[]).map((o: any) => ({
          id: o.id,
          amount: Math.abs(o.amount),
          rate: o.rate,
          period: o.period,
        })),
        autoRenew: autoRenew != null
          ? {
              rate: (autoRenew as any).rate ?? 0,
              period: (autoRenew as any).period ?? 0,
              amount: (autoRenew as any).amount ?? 0,
            }
          : null,
        updatedAt: new Date().toISOString(),
      }

      await writeFile(
        new URL(`${currency}.json`, outdir),
        JSON.stringify(data, null, 2),
      )
      loggers.log(`Exported current status for ${currency}`)
    } catch (err) {
      loggers.error(`Failed to export ${currency}:`, err)
    }
  }
}

async function writeFile (filepath: URL, data: string): Promise<void> {
  await fsPromises.mkdir(new URL('.', filepath), { recursive: true })
  await fsPromises.writeFile(filepath, data)
}

main().catch(err => {
  loggers.error(err)
  process.exit(1)
})
