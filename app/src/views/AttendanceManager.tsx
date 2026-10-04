// ลงเวลางาน for เป้อ / อาร์ต: who is at work today (with selfie + GPS check), "ยืนยันงานวันนี้" confirm-all,
// and check-in on behalf of a worker without a phone (SPEC §4.8)
import { useState } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, thaiDate, todayTH } from '../lib/format'
import { routeFor, ROLE_PERSON, WALLET_TH, WORKTYPE_TH, useProjects } from '../lib/requests'
import type { Profile } from '../lib/types'
import { ProjectTag } from '../components/RequestCard'
import { PhotoPicker, Thumbs } from '../components/Photos'
import { Loading, useAction } from '../components/ui'
import { useWorkers } from './RequestForm'

interface Att {
  id: string; worker_id: string; full_name: string; work_date: string; checked_at: string; checkout_at: string | null; project_id: string
  work_note: string; checkout_note: string | null; selfie_path: string | null; checkout_photos: string[]; distance_m: number | null
  accuracy_m: number | null; flags: string[]; lead_name: string | null; on_behalf_name: string | null
}
interface Claim {
  id: string; worker_id: string | null; claimant_worker_id: string | null; description: string; amount: number; project_id: string
  work_type: string | null; room_code: string | null; work_date: string; attendance_id: string | null; receipt_path: string | null
}

const FLAG: Record<string, string> = {
  no_gps: 'ไม่มีพิกัด', far: 'ห่างหอเกิน 300 ม.', checkout_late: 'ส่งงานเกิน 12 ชม.', no_checkout: 'ไม่ได้ส่งงาน',
  on_behalf: 'ผู้จัดการลงแทน', by_lead: 'หัวหน้าทีมลงให้',
}
const time = (s: string | null) => (s ? new Date(s).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '…')

export default function AttendanceManager({ profile }: { profile: Profile }) {
  const [day, setDay] = useState(todayTH())
  const projects = useProjects()
  const att = useLive<Att[]>(async () => {
    const { data, error } = await supabase.from('v_attendance').select('*').eq('work_date', day).order('checked_at')
    if (error) throw error
    return data as Att[]
  }, ['attendance'], [day])
  const claims = useLive<Claim[]>(async () => {
    const { data, error } = await supabase.from('request_lines').select('*').eq('status', 'claimed').order('created_at')
    if (error) throw error
    return (data || []).map((c: Claim) => ({ ...c, amount: Number(c.amount) }))
  }, ['request_lines'])
  if (!att.data || !claims.data || !projects.data) return <Loading error={att.error || claims.error} />
  const P = projects.data
  const days = [...new Set(claims.data.map((c) => c.work_date))].sort()

  return (
    <>
      {days.length === 0 ? <div className="panel"><h2>ยืนยันงานวันนี้</h2><p className="muted">ยังไม่มีค่าแรง/วัสดุรอยืนยัน — ช่างกด "ส่งงาน" แล้วจะขึ้นที่นี่ทันที</p></div>
        : days.map((d) => <ConfirmDay key={d} day={d} claims={claims.data!.filter((c) => c.work_date === d)} att={att.data!} />)}

      <div className="panel">
        <div className="flex justify-between flex-wrap gap-2 items-center">
          <h2 className="m-0">ลงเวลา {thaiDate(day)} ({att.data.length} คน)</h2>
          <input className="inp" type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="วันที่" />
        </div>
        {!att.data.length ? <p className="muted">ยังไม่มีใครลงเวลา</p> : (
          <div className="scroll mt-2">
            <table className="t">
              <thead><tr><th>คน</th><th>เวลา</th><th>ที่</th><th>งาน</th><th>พิกัด</th><th>รูป</th></tr></thead>
              <tbody>
                {att.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.full_name}{a.flags.filter((f) => ['by_lead', 'on_behalf', 'checkout_late', 'no_checkout'].includes(f)).map((f) => <div key={f} className="muted text-xs">{f === 'by_lead' ? `ลงโดย ${a.lead_name}` : f === 'on_behalf' ? `ลงแทนโดย ${a.on_behalf_name}` : <span className="flag">{FLAG[f]}</span>}</div>)}</td>
                    <td className="whitespace-nowrap">{time(a.checked_at)}–{time(a.checkout_at)}</td>
                    <td><ProjectTag id={a.project_id} projects={P} /></td>
                    <td>{a.work_note}{a.checkout_note && <div className="muted text-xs">เสร็จ: {a.checkout_note}</div>}</td>
                    <td>{a.flags.includes('no_gps') ? <span className="flag">ไม่มีพิกัด</span> : a.distance_m == null ? <span className="muted">±{a.accuracy_m} ม.</span>
                      : a.distance_m > 300 ? <span className="flag">ห่างหอ {fmt(a.distance_m)} ม.</span> : <span className="ok">ที่หอ ({a.distance_m} ม.)</span>}</td>
                    <td><Thumbs paths={[a.selfie_path, ...a.checkout_photos].filter(Boolean) as string[]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {['manager', 'ceo'].includes(profile.role) && <OnBehalf open={att.data.filter((a) => a.work_date === todayTH() && !a.checkout_at)} />}
    </>
  )
}

function ConfirmDay({ day, claims, att }: { day: string; claims: Claim[]; att: Att[] }) {
  const projects = useProjects()
  const workers = useWorkers()
  const { busy, run } = useAction()
  const total = claims.reduce((s, c) => s + c.amount, 0)
  const rt = routeFor(claims.some((c) => c.worker_id) ? 'daily_labor' : 'material', total)
  const byProject = claims.reduce<Record<string, Claim[]>>((m, c) => { (m[c.project_id] = m[c.project_id] || []).push(c); return m }, {})
  const wName = (id: string | null) => workers.data?.find((w) => w.id === id)?.full_name
  const missing = (id: string | null) => workers.data?.find((w) => w.id === id)?.missing || []
  return (
    <div className="panel" style={{ borderLeft: '4px solid var(--in)' }}>
      <h2>ยืนยันงาน {thaiDate(day)} · {claims.length} รายการ · {fmt(total)} บาท</h2>
      <p className="muted">ตรวจรูปงานแล้วกดยืนยันครั้งเดียว ระบบรวมเป็นใบเบิก → อนุมัติโดย {ROLE_PERSON[rt.approver]} · จ่ายโดย {ROLE_PERSON[rt.payer]} จาก{WALLET_TH[rt.wallet]}</p>
      {Object.entries(byProject).map(([pid, list]) => (
        <div key={pid} className="mt-2">
          {projects.data && <ProjectTag id={pid} projects={projects.data} />}
          {list.map((c) => {
            const a = att.find((x) => x.id === c.attendance_id)
            const miss = missing(c.worker_id)
            return (
              <div key={c.id} className="py-1.5" style={{ borderTop: '1px dashed var(--line)' }}>
                <div className="flex justify-between gap-2 flex-wrap">
                  <span>
                    {c.worker_id ? <b>{c.description || wName(c.worker_id)}</b> : <><b>วัสดุ</b> · {c.description}</>}
                    {c.work_type && c.worker_id && <span className="tag">{WORKTYPE_TH[c.work_type]}</span>}
                    {c.room_code && <span className="tag">ห้อง {c.room_code}</span>}
                    {a?.flags.includes('no_gps') && <span className="flag"> · ไม่มีพิกัด</span>}
                    {a?.flags.includes('far') && <span className="flag"> · ห่างหอ {fmt(a.distance_m)} ม.</span>}
                    {miss.length > 0 && <span className="flag"> · ทะเบียนขาด {miss.join(', ')}</span>}
                  </span>
                  <span className="tabular-nums">{fmt(c.amount)}</span>
                </div>
                <Thumbs paths={[...(a?.checkout_photos || []), ...(c.receipt_path ? [c.receipt_path] : [])]} />
                <button className="btn ghost sm" disabled={busy} onClick={() => {
                  const note = prompt('เหตุผลที่ไม่อนุมัติรายการนี้')
                  if (note && note.trim()) run(() => rpc('reject_claim', { p_line: c.id, p_note: note }), 'ไม่อนุมัติรายการแล้ว')
                }}>ไม่อนุมัติรายการนี้</button>
              </div>
            )
          })}
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={() => run(() => rpc<{ no: number; lines: number }>('confirm_claims', { p_date: day, p_line_ids: claims.map((c) => c.id) }),
          (r) => `ยืนยันแล้ว ${r.lines} รายการ → ใบเบิก R${r.no}`)}>ยืนยันทั้งหมด ({claims.length})</button>
      </div>
    </div>
  )
}

function OnBehalf({ open }: { open: Att[] }) {
  const workers = useWorkers()
  const [out, setOut] = useState({ worker_id: '', note: '' })
  const [outPhotos, setOutPhotos] = useState<string[]>([])
  const projects = useProjects()
  const { busy, run } = useAction()
  const [f, setF] = useState({ worker_id: '', project_id: 'N', note: '' })
  const [photo, setPhoto] = useState<string[]>([])
  if (!workers.data || !projects.data) return null
  return (
    <div className="panel">
      <h2>ลงเวลาแทนคนงานที่ไม่มีมือถือ</h2>
      <p className="muted">ระบบบันทึกว่า "ผู้จัดการลงแทน" และขึ้นให้ผู้ตรวจเห็น</p>
      <div className="row">
        <select className="inp" value={f.worker_id} onChange={(e) => setF({ ...f, worker_id: e.target.value })}>
          <option value="">— เลือกคนงาน —</option>
          {workers.data.map((w) => <option key={w.id} value={w.id}>{w.full_name}</option>)}
        </select>
        <select className="inp" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          {projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className="inp" style={{ flex: 1, minWidth: 140 }} placeholder="งานวันนี้" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <PhotoPicker label="ถ่ายรูปคนงานที่หน้างาน" folder="on-behalf" multiple={false} onAdd={setPhoto} />
        <Thumbs paths={photo} />
        <button className="btn" disabled={busy || !f.worker_id || !f.note.trim() || !photo.length} onClick={() => run(async () => {
          const pos = await new Promise<GeolocationPosition | null>((res) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 10000 }) : res(null))
          await rpc('check_in', { payload: { client_ref: crypto.randomUUID(), worker_id: f.worker_id, project_id: f.project_id, work_note: f.note, selfie_path: photo[0],
            lat: pos?.coords.latitude ?? null, lng: pos?.coords.longitude ?? null, accuracy: pos ? Math.round(pos.coords.accuracy) : null, device_at: new Date().toISOString() } })
          setF({ ...f, worker_id: '', note: '' }); setPhoto([])
        }, 'ลงเวลาแทนแล้ว')}>ลงเวลาแทน</button>
      </div>
      {open.length > 0 && (
        <div className="row">
          <b>ส่งงานแทน</b>
          <select className="inp" value={out.worker_id} onChange={(e) => setOut({ ...out, worker_id: e.target.value })}>
            <option value="">— คนที่ยังไม่ส่งงาน —</option>
            {open.map((a) => <option key={a.worker_id} value={a.worker_id}>{a.full_name}</option>)}
          </select>
          <input className="inp" style={{ flex: 1, minWidth: 140 }} placeholder="ทำอะไรเสร็จ" value={out.note} onChange={(e) => setOut({ ...out, note: e.target.value })} />
          <PhotoPicker label="รูปงาน" folder="on-behalf" onAdd={(p) => setOutPhotos([...outPhotos, ...p].slice(0, 5))} />
          <Thumbs paths={outPhotos} />
          <button className="btn" disabled={busy || !out.worker_id || !out.note.trim() || !outPhotos.length} onClick={() => run(async () => {
            await rpc('check_out', { payload: { client_ref: crypto.randomUUID(), worker_id: out.worker_id, note: out.note, photos: outPhotos, device_at: new Date().toISOString() } })
            setOut({ worker_id: '', note: '' }); setOutPhotos([])
          }, 'ส่งงานแทนแล้ว · ค่าแรงขึ้นในรายการรอยืนยัน')}>ส่งงานแทน</button>
        </div>
      )}
    </div>
  )
}
