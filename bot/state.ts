import _ from 'lodash'

export interface Credit {
  id: number
  amount: number
  rate: number
  period: number
  mtsOpening: number
  mtsLastPayout: number | null
}

export interface Offer {
  id: number
  amount: number
  rate: number
  period: number
}

export interface AutoRenew {
  rate: number
  period: number
  amount: number
}

export interface MarketTick {
  rate: number
  amount: number
  period: number
  mts: number
}

export interface CurrencyState {
  currency: string
  wallet: { balance: number, available: number }
  credits: Credit[]
  offers: Offer[]
  autoRenew: AutoRenew | null
  market: {
    frr: number | null
    lastTrade: MarketTick | null
    avgPeriod: number | null
  }
  derived: {
    creditsSum: number
    offersSum: number
    weightedRate: number
  }
  updatedAt: number
}

type Listener = (currency: string, state: CurrencyState) => void

export class StateStore {
  private states = new Map<string, CurrencyState>()
  private listeners = new Set<Listener>()

  constructor (currencies: string[]) {
    for (const cur of currencies) {
      this.states.set(cur, this.empty(cur))
    }
  }

  private empty (currency: string): CurrencyState {
    return {
      currency,
      wallet: { balance: 0, available: 0 },
      credits: [],
      offers: [],
      autoRenew: null,
      market: { frr: null, lastTrade: null, avgPeriod: null },
      derived: { creditsSum: 0, offersSum: 0, weightedRate: 0 },
      updatedAt: Date.now(),
    }
  }

  get (currency: string): CurrencyState | undefined {
    return this.states.get(currency)
  }

  all (): CurrencyState[] {
    return Array.from(this.states.values())
  }

  patch (currency: string, patch: Partial<CurrencyState>): CurrencyState {
    const current = this.states.get(currency) ?? this.empty(currency)
    const merged: CurrencyState = {
      ...current,
      ...patch,
      wallet: { ...current.wallet, ...(patch.wallet ?? {}) },
      market: { ...current.market, ...(patch.market ?? {}) },
      updatedAt: Date.now(),
    }
    merged.derived = this.deriveStats(merged)
    this.states.set(currency, merged)
    this.notify(currency, merged)
    return merged
  }

  private deriveStats (s: CurrencyState) {
    const creditsSum = _.sumBy(s.credits, c => c.amount)
    const offersSum = _.sumBy(s.offers, o => o.amount)
    const weightedRate = creditsSum > 0
      ? _.sumBy(s.credits, c => c.amount * c.rate) / creditsSum
      : 0
    return { creditsSum, offersSum, weightedRate }
  }

  setCredits (currency: string, credits: Credit[]): CurrencyState {
    return this.patch(currency, { credits })
  }

  setOffers (currency: string, offers: Offer[]): CurrencyState {
    return this.patch(currency, { offers })
  }

  upsertCredit (currency: string, credit: Credit): CurrencyState {
    const s = this.states.get(currency) ?? this.empty(currency)
    const credits = [...s.credits.filter(c => c.id !== credit.id), credit]
    return this.patch(currency, { credits })
  }

  removeCredit (currency: string, id: number): CurrencyState {
    const s = this.states.get(currency) ?? this.empty(currency)
    return this.patch(currency, { credits: s.credits.filter(c => c.id !== id) })
  }

  upsertOffer (currency: string, offer: Offer): CurrencyState {
    const s = this.states.get(currency) ?? this.empty(currency)
    const offers = [...s.offers.filter(o => o.id !== offer.id), offer]
    return this.patch(currency, { offers })
  }

  removeOffer (currency: string, id: number): CurrencyState {
    const s = this.states.get(currency) ?? this.empty(currency)
    return this.patch(currency, { offers: s.offers.filter(o => o.id !== id) })
  }

  subscribe (listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify (currency: string, state: CurrencyState) {
    for (const l of this.listeners) {
      try { l(currency, state) } catch { /* ignore listener errors */ }
    }
  }
}
