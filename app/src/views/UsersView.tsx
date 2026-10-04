// ผู้ใช้งาน — create accounts (phone + role) → one-time activation code; reissue code when someone forgets the PIN
import { useState } from 'react'
import { supabase, rpc, edge } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmtPhone, thaiDate } from '../lib/format'
import { ROLE_TH, type Profile, type Role } from '../lib/types'
import { Loading, Modal, useAction } from '../components/ui'

// same rule as supabase/functions/admin-create-user (server enforces it)
const ALL: Role[] = ['ceo', 'manager', 'finance_field', 'finance', 'auditor', 'worker']
const MAY_CREATE: Record<string, Role[]> = {
  ceo: ALL, manager: ALL, finance_field: ALL,
  finance: ALL.filter((r) => r !== 'ceo'),
}

export default function UsersView({ profile }: { profile: Profile }) {
  const allowed = MAY_CREATE[profile.role] || []
  const { busy, run } = useAction()
  const [form, setForm] = useState({ phone: '', display_name: '', role: allowed[0] || 'worker', worker_id: '' })
  const [code, setCode] = useState<{ phone: string; activation_code: string; expires_at: string } | null>(null)

  const data = useLive(async () => {
    const [{ data: users, error }, { data: workers }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('v_workers').select('id, full_name').eq('active', true).order('full_name'),
    ])
    if (error) throw error
    const { data: plans } = await supabase.from('salary_plans').select('profile_id, monthly')
    return { users: users as Profile[], workers: (workers || []) as { id: string; full_name: string }[],
             plans: Object.fromEntries(((plans || []) as { profile_id: string; monthly: number }[]).map((p) => [p.profile_id, Number(p.monthly)])) }
  }, ['profiles', 'workers', 'salary_plans'])
  if (!data.data) return <Loading error={data.error} />

  const create = () => run(async () => {
    const r = await edge<{ phone: string; activation_code: string; expires_at: string }>('admin-create-user', {
      phone: form.phone, display_name: form.display_name, role: form.role, worker_id: form.worker_id || null,
    })
    setCode(r)
    setForm({ ...form, phone: '', display_name: '', worker_id: '' })
    return r
  })

  return (
    <>
      {allowed.length > 0 && (
        <div className="panel">
          <h2>เพิ่มผู้ใช้</h2>
          <p className="muted">ระบบออกรหัสเปิดใช้งาน 8 หลัก (ใช้ได้ 24 ชม.) ให้ส่งให้เจ้าตัว → เจ้าตัวตั้ง PIN เอง ผู้ดูแลไม่รู้ PIN</p>
          <div className="row">
            <input className="inp" type="tel" inputMode="numeric" placeholder="เบอร์โทร 10 หลัก" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} style={{ width: 150 }} />
            <input className="inp" placeholder="ชื่อที่แสดง เช่น นุ้ย" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} style={{ width: 160 }} />
            <select className="inp" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {allowed.map((r) => <option key={r} value={r}>{ROLE_TH[r]}</option>)}
            </select>
            {form.role === 'worker' && (
              <select className="inp" value={form.worker_id} onChange={(e) => setForm({ ...form, worker_id: e.target.value })}>
                <option value="">— เลือกคนในทะเบียน —</option>
                {data.data.workers.map((w) => <option key={w.id} value={w.id}>{w.full_name}</option>)}
              </select>
            )}
            <button className="btn" disabled={busy || form.phone.length !== 10 || form.display_name.trim().length < 2 || (form.role === 'worker' && !form.worker_id)} onClick={create}>สร้างและออกรหัส</button>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>ผู้ใช้ทั้งหมด ({data.data.users.length})</h2>
        <div className="scroll">
          <table className="t">
            <thead><tr><th>ชื่อ</th><th>เบอร์</th><th>สิทธิ์</th><th>สถานะ</th>{profile.role === 'ceo' && <th>เงินเดือน/เดือน</th>}<th></th></tr></thead>
            <tbody>
              {data.data.users.map((u) => {
                const manageable = u.id !== profile.id && allowed.includes(u.role)
                return (
                  <tr key={u.id} className={u.active ? '' : 'vacant'}>
                    <td>{u.display_name}</td>
                    <td>{fmtPhone(u.phone)}</td>
                    <td>
                      {manageable ? (
                        <select className="inp" value={u.role} disabled={busy}
                                onChange={(e) => run(() => rpc('admin_update_profile', { p_id: u.id, p_display_name: u.display_name, p_role: e.target.value, p_active: u.active }), 'เปลี่ยนสิทธิ์แล้ว')}>
                          {allowed.map((r) => <option key={r} value={r}>{ROLE_TH[r]}</option>)}
                        </select>
                      ) : ROLE_TH[u.role]}
                    </td>
                    <td>{u.active ? <span className="ok">ใช้งาน</span> : <span className="muted">ปิด</span>}{u.consent_at && <div className="muted text-xs">ยินยอม PDPA {thaiDate(u.consent_at.slice(0, 10))}</div>}</td>
                    {profile.role === 'ceo' && (
                      <td>{['manager', 'finance_field'].includes(u.role) || data.data!.plans[u.id] != null
                        ? <SalaryPlan id={u.id} value={data.data!.plans[u.id]} fallback={u.role === 'manager' ? 17000 : u.role === 'finance_field' ? 10000 : 0} />
                        : <span className="muted">—</span>}</td>
                    )}
                    <td className="whitespace-nowrap">
                      {manageable && (
                        <>
                          <button className="btn ghost sm" disabled={busy} onClick={() => confirm(`ออกรหัสใหม่ให้ ${u.display_name}? PIN เดิมจะใช้ไม่ได้`) &&
                            run(async () => setCode(await edge('admin-create-user', { phone: u.phone, reissue: true })))}>ออกรหัสใหม่ (ลืม PIN)</button>{' '}
                          <button className="btn ghost sm" disabled={busy} onClick={() =>
                            run(() => rpc('admin_update_profile', { p_id: u.id, p_display_name: u.display_name, p_role: u.role, p_active: !u.active }), u.active ? 'ปิดบัญชีแล้ว' : 'เปิดบัญชีแล้ว')}>
                            {u.active ? 'ปิดบัญชี' : 'เปิดบัญชี'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {code && (
        <Modal title="รหัสเปิดใช้งาน" onClose={() => setCode(null)}>
          <p>ส่งให้เจ้าของเบอร์ {fmtPhone(code.phone)} เท่านั้น</p>
          <p className="text-3xl font-bold tracking-[0.3em] my-3">{code.activation_code}</p>
          <p className="muted">ใช้ได้ถึง {new Date(code.expires_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} · ครั้งเดียว · ปิดหน้าต่างนี้แล้วจะดูรหัสอีกไม่ได้</p>
          <p className="muted">วิธีใช้: เปิดเว็บ → "ครั้งแรก หรือ ลืม PIN" → ใส่เบอร์ + รหัสนี้ → ตั้ง PIN 6 หลักของตัวเอง</p>
        </Modal>
      )}
    </>
  )
}

function SalaryPlan({ id, value, fallback }: { id: string; value: number | undefined; fallback: number }) {
  const [v, setV] = useState(String(value ?? fallback))
  const { busy, run } = useAction()
  const changed = Number(v) !== (value ?? fallback) || value == null
  return (
    <span className="inline-flex gap-1 items-center">
      <input className="inp" type="number" inputMode="decimal" style={{ width: 90 }} value={v} onChange={(e) => setV(e.target.value)} />
      {changed && <button className="btn ghost sm" disabled={busy} onClick={() => run(() => rpc('set_salary_plan', { p_profile: id, p_monthly: Number(v) }), 'บันทึกเงินเดือนแล้ว')}>บันทึก</button>}
      {value == null && <span className="muted text-xs">ค่าตั้งต้น</span>}
    </span>
  )
}
