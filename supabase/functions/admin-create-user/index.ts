// POST { phone, display_name, role, worker_id? }            → create account + one-time activation code
// POST { phone, reissue: true }                              → new activation code ("ลืม PIN")
// Caller must be ceo / manager / finance_field (any role) or finance (non-CEO roles).
import { ACTIVATION_HOURS, admin, caller, codeHash, cors, emailFor, fail, json, normPhone, phoneOk, randomDigits } from '../_shared/util.ts'

const ROLES = ['ceo', 'manager', 'finance_field', 'finance', 'auditor', 'worker']
// Owner decision 1 ต.ค. 69: เป้อ (manager) and นุ้ย (finance_field) run the Phitsanulok site and may create
// every role, like the CEO. กวาง (finance) may create everything except CEO.
const MAY_CREATE: Record<string, string[]> = {
  ceo: ROLES,
  manager: ROLES,
  finance_field: ROLES,
  finance: ROLES.filter((r) => r !== 'ceo'),
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('method not allowed', 405)

  const me = await caller(req)
  if (!me || !MAY_CREATE[me.role]) return fail('คุณไม่มีสิทธิ์สร้างบัญชีผู้ใช้', 403)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return fail('ข้อมูลไม่ถูกต้อง') }
  const phone = normPhone(body.phone)
  if (!phoneOk(phone)) return fail('เบอร์โทรต้องเป็นตัวเลข 10 หลัก ขึ้นต้นด้วย 0')

  const db = admin()
  const { data: existing } = await db.from('profiles').select('id, role, display_name').eq('phone', phone).maybeSingle()
  let profileId: string

  if (body.reissue) {
    if (!existing) return fail('ไม่พบผู้ใช้เบอร์นี้', 404)
    if (!MAY_CREATE[me.role].includes(existing.role)) return fail('คุณไม่มีสิทธิ์ออกรหัสให้บัญชีนี้', 403)
    profileId = existing.id
    // the old PIN stops working until the user activates again
    await db.auth.admin.updateUserById(profileId, { password: crypto.randomUUID() + 'Aa1!' })
    await db.from('activation_codes').update({ used_at: new Date().toISOString() }).eq('profile_id', profileId).is('used_at', null)
  } else {
    if (existing) return fail('มีผู้ใช้เบอร์นี้แล้ว — ถ้าลืม PIN ให้กด "ออกรหัสใหม่"')
    const role = String(body.role || '')
    const name = String(body.display_name || '').trim()
    if (!ROLES.includes(role)) return fail('สิทธิ์ไม่ถูกต้อง')
    if (!MAY_CREATE[me.role].includes(role)) return fail('คุณไม่มีสิทธิ์สร้างบัญชีระดับนี้', 403)
    if (name.length < 2) return fail('ใส่ชื่อที่แสดง')
    const workerId = body.worker_id ? String(body.worker_id) : null
    if (role === 'worker' && !workerId) return fail('บัญชีช่าง/แม่บ้าน ต้องเลือกคนในทะเบียนคนงาน')

    const { data: created, error } = await db.auth.admin.createUser({
      email: emailFor(phone), password: crypto.randomUUID() + 'Aa1!', email_confirm: true,
      user_metadata: { phone, display_name: name },
    })
    if (error || !created.user) return fail('สร้างบัญชีไม่สำเร็จ: ' + (error?.message || ''), 500)
    profileId = created.user.id
    const { error: pe } = await db.from('profiles').insert({ id: profileId, display_name: name, phone, role, worker_id: workerId })
    if (pe) {
      await db.auth.admin.deleteUser(profileId)
      return fail('บันทึกโปรไฟล์ไม่สำเร็จ: ' + pe.message, 500)
    }
  }

  const code = randomDigits(8)
  const expires = new Date(Date.now() + ACTIVATION_HOURS * 3600_000).toISOString()
  const { error: ce } = await db.from('activation_codes').insert({
    profile_id: profileId, code_hash: await codeHash(phone, code), expires_at: expires, created_by: me.id,
  })
  if (ce) return fail('ออกรหัสไม่สำเร็จ: ' + ce.message, 500)
  return json({ profile_id: profileId, phone, activation_code: code, expires_at: expires })
})
