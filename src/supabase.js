import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export async function insertTradeLog(payload) {
  const { data, error } = await supabase
    .from('btc_trade_logs')
    .insert(payload)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function getLatestSignal() {
  const { data, error } = await supabase
    .from('btc_trade_logs')
    .select('*')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getTradeLogs(limit = 50) {
  const { data, error } = await supabase
    .from('btc_trade_logs')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data || []
}

export async function getLatestPushByDirection(direction) {
  const { data, error } = await supabase
    .from('btc_push_history')
    .select('*')
    .eq('direction', direction)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function insertPushHistory(payload) {
  const { data, error } = await supabase
    .from('btc_push_history')
    .insert(payload)
    .select()
    .single()

  if (error) throw error
  return data
}