import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl!, supabaseAnonKey!)

// 服務器端客戶端（用於 API routes）
export function createServiceClient() {
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseServiceKey) {
    throw new Error('Missing SUPABASE_SERVICE_KEY')
  }

  return createClient(supabaseUrl!, supabaseServiceKey)
}
