import { NextRequest, NextResponse } from 'next/server'
import { fetchStatus } from '@/lib/bitfinex-server'

const SUPPORTED_CURRENCIES = ['USD', 'UST']

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const currency = (searchParams.get('currency') ?? 'USD').toUpperCase()

  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return NextResponse.json(
      { error: `不支援的幣種：${currency}` },
      { status: 400 }
    )
  }

  try {
    const data = await fetchStatus(currency)
    return NextResponse.json(data)
  } catch (err: any) {
    console.error('[api/status] error:', err?.message ?? err)
    return NextResponse.json(
      { error: err?.message ?? '取得資料失敗，請稍後再試' },
      { status: 500 }
    )
  }
}
