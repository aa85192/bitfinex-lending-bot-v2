import { createServiceClient } from '@/lib/supabase'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createServiceClient()

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('user_id', 'wtkuo')
      .single()

    if (error && error.code !== 'PGRST116') {
      throw error
    }

    // 如果沒有記錄，返回預設值
    if (!data) {
      return NextResponse.json({
        user_id: 'wtkuo',
        usd_enabled: true,
        usd_min_amount: 150,
        usd_max_amount: 10000,
        usd_rate_min: 0.0001,
        usd_rate_max: 0.01,
        usd_rank: 0.8,
        usdt_enabled: true,
        usdt_min_amount: 150,
        usdt_max_amount: 10000,
        usdt_rate_min: 0.0001,
        usdt_rate_max: 0.01,
        usdt_rank: 0.8,
        bitfinex_api_key: '',
        bitfinex_api_secret: '',
        telegram_token: '',
        telegram_chat_id: ''
      })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Settings fetch error:', error)
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const config = await request.json()

    const { data, error } = await supabase
      .from('settings')
      .upsert({
        user_id: 'wtkuo',
        ...config,
        updated_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      throw error
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Settings save error:', error)
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  }
}
