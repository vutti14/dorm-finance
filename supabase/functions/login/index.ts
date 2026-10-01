// POST { phone, pin } → session. Public (verify_jwt = false). Locks the phone 15 min after 5 wrong tries (SPEC §3).
import { admin, cors, fail, json, lockMinutesLeft, normPhone, phoneOk, pinOk, recordAttempt, signIn } from '../_shared/util.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('method not allowed', 405)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return fail('ข้อมูลไม่ถูกต้อง') }

  const phone = normPhone(body.phone)
  const pin = String(body.pin ?? '')
  if (!phoneOk(phone) || !pinOk(pin)) return fail('ใส่เบอร์โทร 10 หลัก และ PIN 6 หลัก')

  const db = admin()
  const left = await lockMinutesLeft(db, phone)
  if (left) return fail(`ใส่ PIN ผิดหลายครั้ง ล็อกไว้ ${left} นาที — หรือขอรหัสใหม่จากผู้ดูแล`, 429)

  const { data: prof } = await db.from('profiles').select('id, active').eq('phone', phone).maybeSingle()
  const { data: s, error } = prof?.active ? await signIn(phone, pin) : { data: null, error: true }
  if (error || !s?.session) {
    await recordAttempt(db, phone, false)
    const after = await lockMinutesLeft(db, phone)
    return fail(after ? `ใส่ PIN ผิดหลายครั้ง ล็อกไว้ ${after} นาที` : 'เบอร์โทรหรือ PIN ไม่ถูกต้อง', 401)
  }
  await recordAttempt(db, phone, true)
  return json({ access_token: s.session.access_token, refresh_token: s.session.refresh_token })
})
