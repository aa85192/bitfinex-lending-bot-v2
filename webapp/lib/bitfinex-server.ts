import { Bitfinex } from '@taichunmin/bitfinex'

export interface WalletInfo {
  balance: number
}

export interface CreditInfo {
  id: number
  amount: number
  rate: number
  period: number
  mtsOpening: string
  mtsLastPayout: string | null
}

export interface OfferInfo {
  id: number
  amount: number
  rate: number
  period: number
}

export interface AutoRenewInfo {
  rate: number
  period: number
  amount: number
}

export interface StatusResponse {
  wallet: WalletInfo
  credits: CreditInfo[]
  offers: OfferInfo[]
  autoRenew: AutoRenewInfo | null
  updatedAt: string
}

function getBitfinex(): Bitfinex {
  const apiKey = process.env.BITFINEX_API_KEY
  const apiSecret = process.env.BITFINEX_API_SECRET
  if (!apiKey || !apiSecret) {
    throw new Error('BITFINEX_API_KEY 或 BITFINEX_API_SECRET 未設定')
  }
  return new Bitfinex({ apiKey, apiSecret })
}

export async function fetchStatus(currency: string): Promise<StatusResponse> {
  const bfx = getBitfinex()

  const [wallets, credits, offers, autoRenew] = await Promise.all([
    bfx.v2AuthReadWallets(),
    bfx.v2AuthReadFundingCredits({ currency }),
    bfx.v2AuthReadFundingOffers({ currency }),
    bfx.v2AuthReadFundingAutoStatus({ currency }).catch(() => null),
  ])

  // Find funding wallet for the given currency
  const fundingWallet = wallets.find(
    (w: any) => w.type === 'funding' && w.currency === currency
  )

  const wallet: WalletInfo = {
    balance: fundingWallet?.balance ?? 0,
  }

  const creditList: CreditInfo[] = (credits as any[])
    .filter((c: any) => c.side === 1) // lender side only
    .map((c: any) => ({
      id: c.id,
      amount: Math.abs(c.amount),
      rate: c.rate,
      period: c.period,
      mtsOpening: c.mtsOpening instanceof Date
        ? c.mtsOpening.toISOString()
        : new Date(c.mtsOpening).toISOString(),
      mtsLastPayout: c.mtsLastPayout
        ? (c.mtsLastPayout instanceof Date
          ? c.mtsLastPayout.toISOString()
          : new Date(c.mtsLastPayout).toISOString())
        : null,
    }))

  const offerList: OfferInfo[] = (offers as any[]).map((o: any) => ({
    id: o.id,
    amount: Math.abs(o.amount),
    rate: o.rate,
    period: o.period,
  }))

  const autoRenewInfo: AutoRenewInfo | null = autoRenew
    ? {
        rate: (autoRenew as any).rate ?? 0,
        period: (autoRenew as any).period ?? 0,
        amount: (autoRenew as any).amount ?? 0,
      }
    : null

  return {
    wallet,
    credits: creditList,
    offers: offerList,
    autoRenew: autoRenewInfo,
    updatedAt: new Date().toISOString(),
  }
}
