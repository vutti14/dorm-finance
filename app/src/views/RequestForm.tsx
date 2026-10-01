// ขอเบิก — daily labor + materials, and common expenses (prototype VIEWS['ขอเบิก'])
import { useEffect, useMemo, useState } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, todayTH } from '../lib/format'
import { routeFor, ROLE_PERSON, WALLET_TH, useProjects, type Project, type ReqType } from '../lib/requests'
import { PhotoPicker, Thumbs } from '../components/Photos'
import { Loading, useAction } from '../components/ui'

export interface WorkerRow { id: string; full_name: string; kind: string; daily_rate: number; phone: string | null; national_id: string | null; has_national_id: boolean; id_card_path: string | null; is_team_lead: boolean; active: boolean; missing: string[] }
interface Pick { on: boolean; project_id: string; work_type: string; room_code: string }
interface Mat { description: string; amount: string; project_id: string; work_type: string }

export const workerMissing = (w: WorkerRow) => w.missing

export function useWorkers(includeInactive = false) {
  return useLive<WorkerRow[]>(async () => {
    let q = supabase.from('v_workers').select('*').order('full_name')
    if (!includeInactive) q = q.eq('active', true)
    const { data, error } = await q
    if (error) throw error
    // v_workers masks the ID for most roles; completeness is checked server-side with the real number
    const { data: st } = await supabase.rpc('workers_complete')
    const miss = new Map(((st || []) as { id: string; missing: string[] }[]).map((x) => [x.id, x.missing]))
    return (data || []).map((w: any) => ({ ...w, daily_rate: Number(w.daily_rate), missing: miss.get(w.id) ?? [] })) as WorkerRow[]
  }, ['workers'])
}

const ProjSel = ({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: Project[] }) => (
  <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select>
)
const WtSel = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="routine">ซ่อมประจำ</option><option value="renovation">สร้าง/ปรับปรุงห้อง</option><option value="project">งานโครงการ</option>
  </select>
)

export default function RequestForm({ onSent }: { onSent: () => void }) {
  const projects = useProjects()
  const workers = useWorkers()
  const { busy, run } = useAction()
  const [date, setDate] = useState(todayTH())
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [mats, setMats] = useState<Mat[]>([])
  const [work, setWork] = useState<string[]>([])
  const [cmn, setCmn] = useState<Mat[]>([])
  const [receipts, setReceipts] = useState<string[]>([])

  const list = workers.data || []
  // pre-tick workers who checked in today and have no wage claim yet (SPEC §4.8 "manager's form pre-ticks")
  const att = useLive<{ worker_id: string; project_id: string; checkout_at: string | null }[]>(async () => {
    const { data } = await supabase.from('attendance').select('worker_id, project_id, checkout_at').eq('work_date', date)
    return data || []
  }, ['attendance'], [date])
  const checkedIn = (att.data || []).filter((a) => !a.checkout_at)
  useEffect(() => {
    if (!checkedIn.length) return
    setPicks((cur) => {
      const next = { ...cur }
      for (const a of checkedIn) if (!next[a.worker_id]) next[a.worker_id] = { on: true, project_id: a.project_id, work_type: a.project_id === 'N503' ? 'renovation' : 'routine', room_code: a.project_id === 'N503' ? '503' : '' }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.data])
  const pick = (id: string): Pick => picks[id] || { on: false, project_id: 'N', work_type: 'routine', room_code: '' }
  const setPick = (id: string, p: Partial<Pick>) => setPicks({ ...picks, [id]: { ...pick(id), ...p } })

  const lines = useMemo(() => [
    ...list.filter((w) => pick(w.id).on).map((w) => ({ worker_id: w.id, amount: w.daily_rate, project_id: pick(w.id).project_id, work_type: pick(w.id).work_type, room_code: pick(w.id).room_code, work_date: date })),
    ...mats.filter((m) => Number(m.amount) > 0).map((m) => ({ description: m.description || 'วัสดุ', amount: Number(m.amount), project_id: m.project_id, work_type: m.work_type })),
  ], [picks, mats, list, date])
  const total = lines.reduce((s, l) => s + l.amount, 0)
  const type: ReqType = lines.some((l) => 'worker_id' in l) ? 'daily_labor' : 'material'
  const rt = routeFor(type, total)
  const cmnLines = cmn.filter((m) => Number(m.amount) > 0)
  const cmnTotal = cmnLines.reduce((s, l) => s + Number(l.amount), 0)

  if (!projects.data || !workers.data) return <Loading error={projects.error || workers.error} />
  const P = projects.data

  return (
    <>
      <div className="panel">
        <h2>ขอเบิกค่าแรงรายวัน + วัสดุ</h2>
        {checkedIn.length > 0
          ? <div className="note">วันนี้ลงเวลาแล้ว {checkedIn.length} คน — ติ๊กและเลือกโครงการให้อัตโนมัติ · ถ้าช่างกด "ส่งงาน" เอง ค่าแรงจะไปรอที่แท็บลงเวลางาน (ไม่ต้องเบิกซ้ำที่นี่)</div>
          : <div className="note">ยังไม่มีใครลงเวลาวันนี้ — ให้ช่าง/แม่บ้านลงเวลาด้วยมือถือ จะได้ไม่ต้องกรอกซ้ำ</div>}
        <div className="row"><label>วันที่ทำงาน <input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>
        <h3>ใครมาทำงาน — 1 คน 1 โครงการ</h3>
        <div className="scroll">
          <table className="t">
            <thead><tr><th>คน</th><th className="n">ค่าแรง</th><th>โครงการ</th><th>ประเภทงาน</th><th>ห้อง</th></tr></thead>
            <tbody>
              {list.map((w) => {
                const miss = workerMissing(w)
                const p = pick(w.id)
                return miss.length ? (
                  <tr key={w.id} className="vacant"><td>{w.full_name}</td><td className="n">{fmt(w.daily_rate)}</td><td colSpan={3} className="flag">เบิกไม่ได้ — ขาด {miss.join(', ')} (แก้ที่แท็บทะเบียนคนงาน)</td></tr>
                ) : (
                  <tr key={w.id}>
                    <td><label className="inline-flex gap-1.5 items-center"><input type="checkbox" checked={p.on} onChange={(e) => setPick(w.id, { on: e.target.checked })} /> {w.full_name}</label></td>
                    <td className="n">{fmt(w.daily_rate)}</td>
                    <td><ProjSel value={p.project_id} onChange={(v) => setPick(w.id, { project_id: v, ...(v === 'N503' ? { work_type: 'renovation', room_code: '503' } : {}) })} projects={P} /></td>
                    <td><WtSel value={p.work_type} onChange={(v) => setPick(w.id, { work_type: v })} /></td>
                    <td><input className="inp" style={{ width: 70 }} placeholder="ห้อง" value={p.room_code} onChange={(e) => setPick(w.id, { room_code: e.target.value })} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <h3>รูปงานวันนี้ (ต้องมีอย่างน้อย 1 รูป ถ้ามีค่าแรง)</h3>
        <div className="row"><PhotoPicker label="ถ่ายรูป / เลือกรูป" folder="work" onAdd={(p) => setWork([...work, ...p])} /><Thumbs paths={work} /></div>
        <h3>วัสดุ / ค่าใช้จ่ายอื่น</h3>
        {mats.map((m, i) => (
          <div className="row" key={i}>
            <input className="inp" style={{ flex: 1, minWidth: 150 }} placeholder="ร้าน / รายการ" value={m.description} onChange={(e) => setMats(mats.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
            <input className="inp" type="number" inputMode="decimal" style={{ width: 100 }} placeholder="บาท" value={m.amount} onChange={(e) => setMats(mats.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
            <ProjSel value={m.project_id} onChange={(v) => setMats(mats.map((x, j) => j === i ? { ...x, project_id: v } : x))} projects={P} />
            <WtSel value={m.work_type} onChange={(v) => setMats(mats.map((x, j) => j === i ? { ...x, work_type: v } : x))} />
          </div>
        ))}
        <div className="row"><button className="btn ghost" onClick={() => setMats([...mats, { description: '', amount: '', project_id: 'N', work_type: 'routine' }])}>เพิ่มรายการวัสดุ</button></div>
        <div className="row justify-between" style={{ marginTop: 14 }}>
          <span>รวม <b>{fmt(total)}</b> บาท{total > 0 && <span className="muted"> · อนุมัติโดย {ROLE_PERSON[rt.approver]} · จ่ายโดย {ROLE_PERSON[rt.payer]} จาก{WALLET_TH[rt.wallet]}</span>}</span>
          <button className="btn" disabled={busy || !lines.length}
                  onClick={() => run(async () => {
                    const r = await rpc<{ no: number; status: string }>('submit_request', { payload: { type, work_date: date, lines, attachments: work.map((path) => ({ kind: 'work', path })) } })
                    setPicks({}); setMats([]); setWork([])
                    onSent()
                    return r
                  }, (r) => `ส่งขอเบิก R${r.no} แล้ว · ${r.status === 'to_pay' ? 'รอจ่าย' : 'รออนุมัติ'}`)}>
            ส่งขอเบิก
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>ค่าใช้จ่ายส่วนกลาง</h2>
        <p className="muted">แยกทุกรายการ + ถ่ายใบเสร็จ 1 ใบต่อ 1 รายการ ไม่รับยอดก้อน</p>
        {cmn.map((m, i) => (
          <div className="row" key={i}>
            <input className="inp" style={{ flex: 1, minWidth: 150 }} placeholder="รายการ" value={m.description} onChange={(e) => setCmn(cmn.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
            <input className="inp" type="number" inputMode="decimal" style={{ width: 100 }} placeholder="บาท" value={m.amount} onChange={(e) => setCmn(cmn.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
            <ProjSel value={m.project_id} onChange={(v) => setCmn(cmn.map((x, j) => j === i ? { ...x, project_id: v } : x))} projects={P} />
          </div>
        ))}
        <div className="row">
          <button className="btn ghost" onClick={() => setCmn([...cmn, { description: '', amount: '', project_id: 'SH', work_type: 'routine' }])}>เพิ่มรายการ</button>
          <PhotoPicker label="ถ่ายใบเสร็จ" folder="receipts" onAdd={(p) => setReceipts([...receipts, ...p])} />
          <Thumbs paths={receipts} />
        </div>
        <div className="row justify-between" style={{ marginTop: 14 }}>
          <span>รวม <b>{fmt(cmnTotal)}</b> บาท · ใบเสร็จ {receipts.length}/{cmnLines.length}</span>
          <button className="btn" disabled={busy || !cmnLines.length}
                  onClick={() => run(async () => {
                    const r = await rpc<{ no: number }>('submit_request', { payload: {
                      type: 'common', work_date: todayTH(),
                      lines: cmnLines.map((m) => ({ description: m.description.trim(), amount: Number(m.amount), project_id: m.project_id, work_type: 'routine' })),
                      attachments: receipts.map((path) => ({ kind: 'receipt', path })),
                    } })
                    setCmn([]); setReceipts([])
                    onSent()
                    return r
                  }, (r) => `ส่งขอเบิก R${r.no} แล้ว`)}>
            ส่งขอเบิกส่วนกลาง
          </button>
        </div>
      </div>
    </>
  )
}
