import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configured = Boolean(url && key)

// anon key only — every privileged action is a role-checked RPC on the server
export const supabase = createClient(url || 'http://localhost:54321', key || 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dorm-finance-auth' },
  realtime: { params: { eventsPerSecond: 10 } },
})

/** our own writes refresh every live view at once (realtime also delivers them, this just skips the round trip) */
export const CHANGED_EVENT = 'dorm:changed'
export function notifyChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT))
}

/** Postgres raises Thai messages; surface them as-is */
export function errText(e: unknown): string {
  if (!e) return 'เกิดข้อผิดพลาด'
  if (typeof e === 'string') return e
  const m = (e as { message?: string }).message || ''
  if (/Failed to fetch|NetworkError/i.test(m)) return 'เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่'
  if (/JWT expired/i.test(m)) return 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่'
  return m || 'เกิดข้อผิดพลาด'
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(errText(error))
  notifyChanged()
  return data as T
}

/** call one of our edge functions; returns parsed JSON or throws the Thai error */
export async function edge<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data: s } = await supabase.auth.getSession()
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key || '',
      Authorization: `Bearer ${s.session?.access_token || key}`,
    },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `ผิดพลาด (${res.status})`)
  notifyChanged()
  return j as T
}
