// Public tenant registration form at /r/<room token> — no login, never shows existing tenant data (SPEC §4.6)
import { useEffect, useState } from 'react'
import { supabase, errText } from '../lib/supabase'

interface RoomInfo { room: string; building: string; notice_version: string; has_pending: boolean }

export default function RegisterPage({ token }: { token: string }) {
  const [info, setInfo] = useState<RoomInfo | null | undefined>(undefined)
  const [f, setF] = useState({ name: '', phone: '', line_id: '', emergency_name: '', emergency_phone: '', accepted: false })
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.rpc('registration_room', { p_token: token }).then(({ data }) => setInfo((data as RoomInfo) || null))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('submit_tenant_registration', { p_token: token, p: f })
    setBusy(false)
    if (error) setErr(errText(error))
    else setDone(true)
  }

  const box = (children: React.ReactNode) => <div className="wrap" style={{ maxWidth: 480 }}>{children}</div>
  if (info === undefined) return box(<p className="muted mt-6">กำลังโหลด…</p>)
  if (info === null) return box(<div className="panel mt-6"><h2>ลิงก์ไม่ถูกต้อง</h2><p className="muted">กรุณาขอลิงก์หรือ QR ใหม่จากเจ้าหน้าที่หอพัก</p></div>)
  if (done) return box(<div className="panel mt-6"><h2>ส่งข้อมูลแล้ว ขอบคุณค่ะ</h2><p>เจ้าหน้าที่จะตรวจและยืนยัน ชื่อของคุณจะขึ้นในบิลค่าห้องรอบถัดไป</p></div>)

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  return box(
    <>
      <h1 className="text-[20px] font-bold mt-6 mb-1">{info.building} · ห้อง {info.room}</h1>
      <p className="muted mb-3">ลงทะเบียนผู้เช่า — ใช้ติดต่อเรื่องบิลค่าห้องและกรณีฉุกเฉิน</p>
      {info.has_pending ? (
        <div className="panel"><p>ห้องนี้มีข้อมูลรอเจ้าหน้าที่ตรวจอยู่แล้ว หากต้องการแก้ไข กรุณาติดต่อหอพัก</p></div>
      ) : (
        <form className="panel" onSubmit={submit}>
          {([['name', 'ชื่อ-นามสกุล', 'text', true], ['phone', 'เบอร์โทร', 'tel', true], ['line_id', 'LINE ID (ถ้ามี)', 'text', false],
             ['emergency_name', 'ผู้ติดต่อฉุกเฉิน — ชื่อ', 'text', true], ['emergency_phone', 'ผู้ติดต่อฉุกเฉิน — เบอร์โทร', 'tel', true]] as const).map(([k, label, type, req]) => (
            <label key={k} className="block mb-3">
              <span className="muted">{label}</span>
              <input className="inp w-full" type={type} inputMode={type === 'tel' ? 'numeric' : undefined} required={req} maxLength={120}
                     value={f[k] as string} onChange={set(k)} />
            </label>
          ))}
          <div className="note">
            <b>ประกาศความเป็นส่วนตัว (ฉบับที่ {info.notice_version})</b><br />
            หอพักเก็บชื่อ เบอร์โทร LINE ID และผู้ติดต่อฉุกเฉินของคุณ เพื่อส่งบิลค่าห้อง ติดต่อเรื่องการเช่า และกรณีฉุกเฉินเท่านั้น
            เข้าถึงได้เฉพาะเจ้าหน้าที่ที่เกี่ยวข้อง เก็บไว้ตลอดระยะเวลาเช่าและตามที่กฎหมายกำหนด คุณขอดู แก้ไข หรือลบข้อมูลได้ที่สำนักงานหอพัก
          </div>
          <label className="flex gap-2 items-start my-3">
            <input type="checkbox" checked={f.accepted} onChange={set('accepted')} className="mt-1" />
            <span>ฉันอ่านและยอมรับประกาศความเป็นส่วนตัว</span>
          </label>
          {err && <p className="flag mb-2">{err}</p>}
          <button className="btn w-full justify-center py-2" disabled={busy || !f.accepted}>{busy ? 'กำลังส่ง…' : 'ส่งข้อมูล'}</button>
        </form>
      )}
    </>,
  )
}
