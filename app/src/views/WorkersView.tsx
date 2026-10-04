// ทะเบียนคนงาน — name · phone · national ID (checksum) · ID-card photo. Complete = can be put on a labor request.
import { useState } from 'react'
import { rpc } from '../lib/supabase'
import { fmt, fmtPhone } from '../lib/format'
import { thaiIdOk } from '../lib/thaiId'
import type { Profile } from '../lib/types'
import { PhotoPicker, Thumbs } from '../components/Photos'
import { Loading, useAction } from '../components/ui'
import { useWorkers, type WorkerRow } from './RequestForm'

interface Form { id?: string; full_name: string; kind: string; daily_rate: string; phone: string; national_id: string; id_card_path: string | null; active: boolean }
const blank: Form = { full_name: '', kind: 'technician', daily_rate: '400', phone: '', national_id: '', id_card_path: null, active: true }

export default function WorkersView({ profile }: { profile: Profile }) {
  const workers = useWorkers(true)
  const [edit, setEdit] = useState<Form | null>(null)
  if (!workers.data) return <Loading error={workers.error} />
  const dup: Record<string, number> = {}
  workers.data.forEach((w) => { if (w.phone && w.active) dup[w.phone] = (dup[w.phone] || 0) + 1 })
  const fromRow = (w: WorkerRow): Form => ({ id: w.id, full_name: w.full_name, kind: w.kind, daily_rate: String(w.daily_rate), phone: w.phone || '', national_id: '', id_card_path: null, active: w.active })

  return (
    <div className="panel">
      <h2>ทะเบียนช่างและแม่บ้าน</h2>
      <p className="muted">ต้องมีครบ ชื่อ · เบอร์โทร · เลขบัตรประชาชน · รูปบัตร ก่อนจึงจะเลือกในใบขอเบิกได้ · เลขบัตรเต็มเห็นได้เฉพาะอาร์ตและกวาง</p>
      {workers.data.map((w) => (
        <div key={w.id} className="border rounded-lg p-3 my-2" style={{ borderColor: 'var(--line)', borderLeft: w.missing.length && w.active ? '3px solid var(--out)' : undefined, opacity: w.active ? 1 : 0.6 }}>
          <div className="flex gap-2 flex-wrap items-baseline">
            <b>{w.full_name}</b>
            <span className="tag">{w.kind === 'maid' ? 'แม่บ้าน' : 'ช่าง'}</span>
            <span className="muted">{fmt(w.daily_rate)} บาท/วัน · {fmtPhone(w.phone)} · บัตร {w.national_id || '—'}</span>
            {!w.active ? <span className="muted">ปิดใช้งาน</span> : w.missing.length ? <span className="flag">ขาด: {w.missing.join(', ')}</span> : <span className="ok">ข้อมูลครบ เบิกได้</span>}
            {w.phone && (dup[w.phone] || 0) > 1 && <span className="flag">เบอร์ซ้ำกับคนอื่น</span>}
            {w.is_team_lead && <span className="tag" style={{ borderColor: 'var(--hi)', color: 'var(--hi)' }}>หัวหน้าทีม</span>}
            {w.id_card_path && <Thumbs paths={[w.id_card_path]} />}
            <TeamLead w={w} />
            <button className="btn ghost sm ml-auto" onClick={() => setEdit(fromRow(w))}>แก้ไข</button>
          </div>
          {edit?.id === w.id && <WorkerForm f={edit} setF={setEdit} profile={profile} />}
        </div>
      ))}
      {edit && !edit.id ? <div className="border rounded-lg p-3 my-2" style={{ borderColor: 'var(--line)' }}><WorkerForm f={edit} setF={setEdit} profile={profile} /></div>
        : <div className="row"><button className="btn ghost" onClick={() => setEdit({ ...blank })}>เพิ่มช่าง/แม่บ้าน</button></div>}
    </div>
  )
}

function WorkerForm({ f, setF, profile }: { f: Form; setF: (f: Form | null) => void; profile: Profile }) {
  const { busy, run } = useAction()
  const nidBad = f.national_id !== '' && !thaiIdOk(f.national_id)
  const rateLocked = !!f.id && profile.role !== 'ceo'
  return (
    <>
      <div className="row">
        <input className="inp" style={{ flex: 1, minWidth: 160 }} placeholder="ชื่อ-นามสกุล" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        <select className="inp" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="technician">ช่าง</option><option value="maid">แม่บ้าน</option></select>
        <label className="muted">ค่าแรง/วัน <input className="inp" type="number" style={{ width: 80 }} disabled={rateLocked} title={rateLocked ? 'แก้ค่าแรงได้เฉพาะ CEO' : ''} value={f.daily_rate} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} /></label>
      </div>
      <div className="row">
        <input className="inp" type="tel" inputMode="numeric" style={{ width: 140 }} placeholder="เบอร์โทร" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
        <input className="inp" inputMode="numeric" style={{ width: 200 }} placeholder={f.id ? 'เลขบัตรใหม่ (เว้นว่าง = คงเดิม)' : 'เลขบัตรประชาชน 13 หลัก'} value={f.national_id} onChange={(e) => setF({ ...f, national_id: e.target.value.replace(/\D/g, '').slice(0, 13) })} />
        {nidBad && f.national_id.length === 13 && <span className="flag">เลขบัตรไม่ถูกต้อง</span>}
        <PhotoPicker label={f.id_card_path ? 'มีรูปบัตรใหม่ ✓' : 'รูปบัตร'} folder="id-cards" multiple={false} onAdd={(p) => setF({ ...f, id_card_path: p[0] })} />
        {f.id && <label className="inline-flex gap-1 items-center text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> ใช้งาน</label>}
      </div>
      <div className="row">
        <button className="btn sm" disabled={busy || f.full_name.trim().length < 2 || nidBad}
                onClick={() => run(async () => {
                  await rpc('upsert_worker', { p: {
                    id: f.id, full_name: f.full_name, kind: f.kind, daily_rate: rateLocked ? null : Number(f.daily_rate),
                    phone: f.phone, national_id: f.national_id, id_card_path: f.id_card_path, active: f.active,
                  } })
                  setF(null)
                }, 'บันทึกแล้ว')}>บันทึก</button>
        <button className="btn ghost sm" onClick={() => setF(null)}>ยกเลิก</button>
      </div>
    </>
  )
}

function TeamLead({ w }: { w: WorkerRow }) {
  const { busy, run } = useAction()
  return (
    <button className="btn ghost sm" disabled={busy} title="หัวหน้าทีมลงเวลาและส่งงานแทนลูกทีมที่ไม่มีมือถือได้"
            onClick={() => run(() => rpc('set_team_lead', { p_worker: w.id, p_on: !w.is_team_lead }), w.is_team_lead ? 'เลิกเป็นหัวหน้าทีมแล้ว' : 'ตั้งเป็นหัวหน้าทีมแล้ว')}>
      {w.is_team_lead ? 'เลิกเป็นหัวหน้าทีม' : 'ตั้งเป็นหัวหน้าทีม'}
    </button>
  )
}
