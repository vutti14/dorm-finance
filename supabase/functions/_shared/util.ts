// Shared helpers for the auth edge functions. Runs on Supabase Edge (Deno).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
export const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

export const LOCK_AFTER = 5            // wrong attempts …
export const LOCK_MINUTES = 15         // … lock the phone for this long (SPEC §3)
export const ACTIVATION_HOURS = 24

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
export const fail = (message: string, status = 400) => json({ error: message }, status)

export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}
export function anon(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}

export const normPhone = (p: unknown) => String(p ?? '').replace(/\D/g, '')
export const phoneOk = (p: string) => /^0\d{9}$/.test(p)
export const pinOk = (p: unknown) => /^\d{6}$/.test(String(p ?? ''))
export const emailFor = (phone: string) => `p${phone}@dorm.internal`

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
export const codeHash = (phone: string, code: string) => sha256(`dorm-activation:${phone}:${code}`)

export function randomDigits(n: number): string {
  const a = new Uint32Array(n)
  crypto.getRandomValues(a)
  return Array.from(a, (x) => String(x % 10)).join('')
}

/** minutes left on the lock, or 0. Counts wrong attempts in the window since the last success. */
export async function lockMinutesLeft(db: SupabaseClient, phone: string): Promise<number> {
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString()
  const { data } = await db.from('login_attempts').select('ok, at').eq('phone', phone).gte('at', since)
    .order('at', { ascending: false }).limit(50)
  const fails: string[] = []
  for (const row of data ?? []) {
    if (row.ok) break
    fails.push(row.at)
  }
  if (fails.length < LOCK_AFTER) return 0
  const oldestCounted = Date.parse(fails[LOCK_AFTER - 1])
  return Math.max(1, Math.ceil((oldestCounted + LOCK_MINUTES * 60_000 - Date.now()) / 60_000))
}

export async function recordAttempt(db: SupabaseClient, phone: string, ok: boolean) {
  await db.from('login_attempts').insert({ phone, ok })
}

/** the caller's profile from their JWT, or null */
export async function caller(req: Request): Promise<{ id: string; role: string } | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const db = admin()
  const { data: u } = await db.auth.getUser(token)
  if (!u?.user) return null
  const { data: p } = await db.from('profiles').select('id, role, active').eq('id', u.user.id).single()
  return p && p.active ? { id: p.id, role: p.role } : null
}

export async function signIn(phone: string, pin: string) {
  return await anon().auth.signInWithPassword({ email: emailFor(phone), password: pin })
}
