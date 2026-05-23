import { Bitfinex } from '@taichunmin/bitfinex'

/**
 * Thin wrapper around Bitfinex REST writes. All write methods include
 * nonce-retry to handle the case where two callers race for the same
 * nonce window.
 */
export class RestExecutor {
  constructor (private bitfinex: Bitfinex) {}

  static withNonceRetry = async function <T> (fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err: any) {
        const msg = String(err?.message ?? '')
        const isNonce = msg.includes('10114') || msg.toLowerCase().includes('nonce')
        if (isNonce && attempt < maxRetries - 1) {
          const delay = (attempt + 1) * 4000 + Math.random() * 2000
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw err
      }
    }
    throw new Error('withNonceRetry unreachable')
  }

  async readAutoFundingStatus (currency: string): Promise<any | null> {
    return RestExecutor.withNonceRetry(() =>
      this.bitfinex.v2AuthReadFundingAutoStatus({ currency }).catch(() => null),
    )
  }

  /**
   * Disable existing auto-funding and cancel all outstanding offers,
   * then activate the new auto-funding settings.
   *
   * `rate` here is the absolute daily rate (0.0005 = 0.05%/d). The
   * Bitfinex API expects rate as a percentage value (rate * 100), this
   * function performs that conversion.
   */
  async applyAutoFunding (params: {
    currency: string
    amount: number
    period: number
    rate: number
    deactivateFirst?: boolean
    cancelOffers?: boolean
  }): Promise<void> {
    const { currency, amount, period, rate, deactivateFirst = true, cancelOffers = true } = params

    if (deactivateFirst) {
      await RestExecutor.withNonceRetry(() =>
        this.bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 }),
      ).catch(() => { /* might not exist, ignore */ })
    }
    if (cancelOffers) {
      await RestExecutor.withNonceRetry(() =>
        this.bitfinex.v2AuthWriteFundingOfferCancelAll({ currency }),
      ).catch(() => { /* ignore if nothing to cancel */ })
    }

    await RestExecutor.withNonceRetry(() =>
      this.bitfinex.v2AuthWriteFundingAuto({
        currency,
        amount,
        period,
        rate: rate * 100, // bitfinex expects percentage
        status: 1,
      }),
    )
  }
}
