// POST { phone, code, pin } — first login / forgotten PIN: check the one-time code, set the user's own PIN,
// return a session. Public (verify_jwt = false). Shares the 5-tries / 15-min lock with login.
import { admin, codeHash, cors, fail, json, lockMinutesLeft, normPhone, phoneOk, pinOk, recordAttempt, signIn } from '../_shared/util.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('method not allowed', 405)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return fail('ข้อมูลไม่ถูกต้อง') }

  const phone = normPhone(body.phone)
  const code = String(body.code ?? '').replace(/\D/g, '')
  const pin = String(body.pin ?? '')
  if (!phoneOk(phone)) return fail('เบอร์โทรไม่ถูกต้อง')
  if (!pinOk(pin)) return fail('PIN ต้องเป็นตัวเลข 6 หลัก')
  if (/^(\d)\1{5}$/.test(pin) || ['123456', '654321', '012345', '123123'].includes(pin)) return fail('PIN นี้เดาง่ายเกินไป เลือกใหม่')

  const db = admin()
  const left = await lockMinutesLeft(db, phone)
  if (left) return fail(`ลองผิดหลายครั้ง ล็อกไว้ ${left} นาที`, 429)

  const { data: prof } = await db.from('profiles').select('id, active').eq('phone', phone).maybeSingle()
  const hash = await codeHash(phone, code)
  const { data: ac } = prof
    ? await db.from('activation_codes').select('id, expires_at').eq('profile_id', prof.id).eq('code_hash', hash)
        .is('used_at', null).gt('expires_at', new Date().toISOString()).maybeSingle()
    : { data: null }
  if (!prof || !ac || !prof.active) {
    await recordAttempt(db, phone, false)
    return fail('รหัสเปิดใช้งานไม่ถูกต้องหรือหมดอายุ — ขอรหัสใหม่จากผู้ดูแล', 401)
  }

  const { error } = await db.auth.admin.updateUserById(prof.id, { password: pin })
  if (error) return fail('ตั้ง PIN ไม่สำเร็จ: ' + error.message, 500)
  await db.from('activation_codes').update({ used_at: new Date().toISOString() }).eq('id', ac.id)
  await recordAttempt(db, phone, true)

  const { data: s, error: se } = await signIn(phone, pin)
  if (se || !s.session) return fail('ตั้ง PIN แล้ว แต่เข้าสู่ระบบไม่สำเร็จ ลองเข้าสู่ระบบอีกครั้ง', 500)
  return json({ access_token: s.session.access_token, refresh_token: s.session.refresh_token })
})
