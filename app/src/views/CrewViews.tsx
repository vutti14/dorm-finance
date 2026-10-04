// Crew phone screens (SPEC §4.8): ลงเวลางาน (check-in → ส่งงาน → ขอเบิกค่าวัสดุ, team mode) and ประวัติของฉัน.
// Everything goes through the offline queue so a weak signal at the site never loses a check-in or a photo.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, thaiDate, todayTH } from '../lib/format'
import { compressPhoto } from '../lib/photos'
import { getPosition, submitQueued, useQueue } from '../lib/crew'
import { useProjects, type Project } from '../lib/requests'
import type { Profile } from '../lib/types'
import { Thumbs } from '../components/Photos'
import { Loading, useToast } from '../components/ui'

interface Att { id: string; work_date: string; checked_at: string; checkout_at: string | null; project_id: string; project_name: string; work_note: string; flags: string[]; distance_m: number | null; checkout_photos: string[]; lead_name: string | null }
interface Cand { id: string; full_name: string; checked_in: boolean; checked_out: boolean; by_me: boolean }
interface Me { id: string; full_name: string; is_team_lead: boolean; daily_rate: number }

/** local photos (not uploaded yet): compressed blobs + preview URLs */
function useShots(max: number) {
  const [shots, setShots] = useState<{ blob: Blob; url: string }[]>([])
  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), [])
  const add = async (files: FileList | null) => {
    const list = Array.from(files || []).slice(0, Math.max(0, max - shots.length))
    const out: { blob: Blob; url: string }[] = []
    for (const f of list) {
      // compression failing (old phone, odd format) must not lose the photo: keep the original then
      const blob = await compressPhoto(f).catch(() => f as Blob)
      out.push({ blob, url: URL.createObjectURL(blob) })
    }
    setShots((s) => [...s, ...out].slice(0, max))
  }
  const clear = () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); setShots([]) }
  const remove = (i: number) => setShots((s) => { URL.revokeObjectURL(s[i].url); return s.filter((_, j) => j !== i) })
  return { shots, add, clear, remove }
}

function ShotInput({ label, shots, max, front, onFiles, onRemove }: {
  label: string; shots: { url: string }[]; max: number; front?: boolean; onFiles: (f: FileList | null) => void; onRemove: (i: number) => void
}) {
  return (
    <div className="row">
      {shots.length < max && (
        <label className="btn ghost">
          {label}{max > 1 ? ` (${shots.length}/${max})` : ''}
          <input type="file" accept="image/*" capture={front ? 'user' : 'environment'} multiple={max > 1} hidden
                 onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} />
        </label>
      )}
      {shots.map((s, i) => (
        <span key={s.url} className="relative inline-block">
          <img src={s.url} alt="รูปที่ถ่าย" className="w-[64px] h-[64px] object-cover rounded-md border" style={{ borderColor: 'var(--line)' }} />
          <button className="absolute -top-2 -right-2 badge" style={{ margin: 0, cursor: 'pointer' }} onClick={() => onRemove(i)} aria-label="ลบรูป">×</button>
        </span>
      ))}
    </div>
  )
}

function QueueBanner() {
  const toast = useToast()
  const { ops, retry } = useQueue((r) => {
    if (r.sent.length) toast(`ส่งรายการที่ค้างแล้ว ${r.sent.length} รายการ`)
    for (const f of r.failed) toast(`${f.op.label}: ${f.error}`, true)
  })
  if (!ops.length) return null
  return (
    <div className="panel" style={{ borderLeft: '4px solid var(--A)' }}>
      <b>รอส่ง {ops.length} รายการ</b> <span className="muted">— สัญญาณอ่อน ระบบเก็บไว้ในเครื่อง จะส่งเองเมื่อมีเน็ต</span>
      <div className="muted text-sm">{ops.map((o) => `${o.label} (${new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })})`).join(' · ')}</div>
      <div className="row"><button className="btn ghost sm" onClick={() => retry()}>ลองส่งตอนนี้</button></div>
    </div>
  )
}

const ProjectSelect = ({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: Project[] }) => (
  <select className="inp" value={value} onChange={(e) => onChange(e.target.value)} aria-label="โครงการ">
    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select>
)

export function CrewToday({ profile }: { profile: Profile }) {
  const toast = useToast()
  const projects = useProjects()
  const me = useLive<Me | null>(async () => {
    const { data } = await supabase.from('v_workers').select('id, full_name, is_team_lead, daily_rate').eq('id', profile.worker_id).maybeSingle()
    return data as Me | null
  }, ['workers'])
  const today = useLive<Att | null>(async () => {
    const { data, error } = await supabase.from('v_attendance').select('*').eq('worker_id', profile.worker_id).eq('work_date', todayTH()).maybeSingle()
    if (error) throw error
    return data as Att | null
  }, ['attendance'])
  const team = useLive<Cand[]>(async () => {
    if (!me.data?.is_team_lead) return []
    const { data } = await supabase.rpc('team_candidates')
    return (data || []) as Cand[]
  }, ['attendance'], [me.data?.is_team_lead])

  const [project, setProject] = useState('N')
  const [note, setNote] = useState('')
  const [teamMode, setTeamMode] = useState(false)
  const [members, setMembers] = useState<string[]>([])
  const selfie = useShots(1)
  const work = useShots(5)
  const [doneNote, setDoneNote] = useState('')
  const [workType, setWorkType] = useState('routine')
  const [room, setRoom] = useState('')
  const [busy, setBusy] = useState(false)
  const [mat, setMat] = useState({ shop: '', amount: '', project: 'N' })
  const receipt = useShots(1)
  const [sentLocal, setSentLocal] = useState<'in' | 'out' | null>(null)

  const folder = `crew/${profile.id}`
  const isLead = !!me.data?.is_team_lead
  const teamOut = useMemo(() => (team.data || []).filter((c) => c.by_me && c.checked_in && !c.checked_out), [team.data])
  useEffect(() => { if (project === 'N503') { setWorkType('renovation'); setRoom('503') } }, [project])

  if (!profile.worker_id) return <Loading error="บัญชีนี้ยังไม่ได้ผูกกับคนในทะเบียนคนงาน — ติดต่อเป้อ" />
  if (!projects.data || !me.data) return <Loading error={projects.error || me.error} />

  const report = (r: { queued: true } | { queued: false; result: unknown }, what: string) => {
    if (r.queued) { toast(`${what} — เก็บไว้ในเครื่อง จะส่งเมื่อมีสัญญาณ`); return }
    const res = r.result as { done?: string[]; skipped?: { message: string }[]; has_gps?: boolean; distance_m?: number | null; duplicate?: boolean }
    for (const s of res?.skipped || []) toast(s.message, true)
    if (res?.duplicate) toast(`${what} แล้ว (ส่งซ้ำ ระบบนับครั้งเดียว)`)
    else if (res?.has_gps === false) toast(`${what}แล้ว (ไม่มีพิกัด — จะขึ้นเตือนให้ตรวจ)`)
    else if (res?.distance_m != null && res.distance_m > 300) toast(`${what}แล้ว (ห่างหอ ${fmt(res.distance_m)} ม. — จะขึ้นเตือนให้ตรวจ)`)
    else toast(`${what}แล้ว${res?.done && res.done.length > 1 ? ` · ${res.done.length} คน` : ''}`)
  }

  async function doCheckIn() {
    if (!note.trim()) return toast('บอกว่าวันนี้ทำงานอะไร', true)
    if (!selfie.shots.length) return toast(teamMode ? 'ถ่ายรูปหมู่ให้เห็นหน้าทุกคนก่อน' : 'ถ่ายเซลฟี่กับหน้างานก่อน', true)
    setBusy(true)
    try {
      toast('กำลังขอพิกัด…')
      const pos = await getPosition()
      const r = await submitQueued({
        kind: 'check_in', folder, label: teamMode ? `ลงเวลาเข้า (ทีม ${members.length + 1} คน)` : 'ลงเวลาเข้า',
        payload: { project_id: project, work_note: note.trim(), lat: pos?.lat ?? null, lng: pos?.lng ?? null, accuracy: pos?.accuracy ?? null,
                   device_at: new Date().toISOString(), ...(teamMode ? { member_ids: members } : {}) },
        photos: [{ field: 'selfie_path', blobs: selfie.shots.map((s) => s.blob), multi: false }],
      })
      report(r, 'ลงเวลาเข้า')
      selfie.clear(); setSentLocal('in')
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  async function doCheckOut(teamIds: string[]) {
    if (!doneNote.trim()) return toast('บอกว่าวันนี้ทำอะไรเสร็จ', true)
    if (!work.shots.length) return toast('ถ่ายรูปงานที่ทำเสร็จอย่างน้อย 1 รูป', true)
    if (workType === 'renovation' && !room.trim()) return toast('งานสร้าง/ปรับปรุงห้อง ต้องใส่เลขห้อง', true)
    setBusy(true)
    try {
      const pos = await getPosition(6000)
      const r = await submitQueued({
        kind: 'check_out', folder, label: teamIds.length ? `ส่งงาน (ทีม ${teamIds.length + 1} คน)` : 'ส่งงาน',
        payload: { note: doneNote.trim(), work_type: workType, room_code: room.trim(), lat: pos?.lat ?? null, lng: pos?.lng ?? null,
                   accuracy: pos?.accuracy ?? null, device_at: new Date().toISOString(), ...(teamIds.length ? { member_ids: teamIds } : {}) },
        photos: [{ field: 'photos', blobs: work.shots.map((s) => s.blob), multi: true }],
      })
      report(r, 'ส่งงาน')
      work.clear(); setSentLocal('out')
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  async function doMaterial() {
    if (!mat.shop.trim() || !(Number(mat.amount) > 0)) return toast('ใส่ร้าน/รายการ และจำนวนเงิน', true)
    if (!receipt.shots.length) return toast('ถ่ายรูปใบเสร็จก่อน', true)
    setBusy(true)
    try {
      const r = await submitQueued({
        kind: 'claim_material', folder, label: `ขอเบิกวัสดุ ${fmt(mat.amount)}`,
        payload: { shop: mat.shop.trim(), amount: Number(mat.amount), project_id: mat.project },
        photos: [{ field: 'receipt_path', blobs: receipt.shots.map((s) => s.blob), multi: false }],
      })
      report(r, 'ส่งขอเบิกวัสดุ')
      receipt.clear(); setMat({ ...mat, shop: '', amount: '' })
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  const t = today.data
  const checkedIn = !!t || sentLocal === 'in' || sentLocal === 'out'
  const checkedOut = !!t?.checkout_at || sentLocal === 'out'
  const P = projects.data

  return (
    <>
      <QueueBanner />
      <div className="panel">
        <h2>สวัสดี {me.data.full_name} · {thaiDate(todayTH())}</h2>
        <div className="flex gap-2 flex-wrap text-sm">
          <span className={`tag ${checkedIn ? '' : 'A'}`} style={checkedIn ? { borderColor: 'var(--in)', color: 'var(--in)' } : undefined}>1 ลงเวลาเข้า {checkedIn ? '✓' : ''}</span>
          <span className="tag" style={checkedOut ? { borderColor: 'var(--in)', color: 'var(--in)' } : undefined}>2 ส่งงาน {checkedOut ? '✓' : ''}</span>
        </div>
        {t && (
          <p className="muted mt-2">
            เข้างาน {new Date(t.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} · {t.project_name} · {t.work_note}
            {t.flags.includes('no_gps') && <span className="flag"> · ไม่มีพิกัด</span>}
            {t.flags.includes('far') && <span className="flag"> · ห่างหอ {fmt(t.distance_m)} ม.</span>}
            {t.lead_name && <> · หัวหน้าทีม {t.lead_name} ลงให้</>}
            {t.checkout_at && <> · ส่งงาน {new Date(t.checkout_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</>}
          </p>
        )}
      </div>

      {!checkedIn && (
        <div className="panel">
          <h2>ลงเวลาเข้า</h2>
          {isLead && (
            <label className="inline-flex gap-2 items-center mb-2"><input type="checkbox" checked={teamMode} onChange={(e) => setTeamMode(e.target.checked)} /> ลงเวลาให้ทีม (ลูกทีมไม่มีมือถือ)</label>
          )}
          {teamMode && (
            <div className="note">
              <b>ใครมาวันนี้</b>
              {(team.data || []).map((c) => (
                <label key={c.id} className="flex gap-2 items-center py-0.5">
                  <input type="checkbox" disabled={c.checked_in} checked={members.includes(c.id)}
                         onChange={(e) => setMembers(e.target.checked ? [...members, c.id] : members.filter((x) => x !== c.id))} />
                  {c.full_name}{c.checked_in && <span className="muted"> — ลงเวลาเองแล้ว</span>}
                </label>
              ))}
            </div>
          )}
          <div className="row"><ProjectSelect value={project} onChange={setProject} projects={P} /></div>
          <div className="row"><input className="inp" style={{ flex: 1 }} placeholder="วันนี้ทำงานอะไร เช่น ซ่อมก๊อกห้อง 304" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <ShotInput label={teamMode ? 'ถ่ายรูปหมู่ (เห็นหน้าทุกคน)' : 'ถ่ายเซลฟี่กับหน้างาน'} front={!teamMode} max={1} shots={selfie.shots} onFiles={selfie.add} onRemove={selfie.remove} />
          <div className="row"><button className="btn" disabled={busy} onClick={doCheckIn}>{busy ? 'กำลังส่ง…' : 'ลงเวลาเข้างาน + ส่งพิกัด'}</button></div>
          <p className="muted">ระบบขอพิกัด GPS จากมือถือตอนกดปุ่มเท่านั้น · ถ้าไม่อนุญาต จะบันทึกว่า "ไม่มีพิกัด" และขึ้นเตือนให้ตรวจ</p>
        </div>
      )}

      {checkedIn && !checkedOut && (
        <div className="panel">
          <h2>ส่งงาน (เลิกงาน)</h2>
          <p className="muted">ส่งงานแล้ว ระบบสร้างใบเบิกค่าแรงวันนี้ให้เอง ({fmt(me.data.daily_rate)} บาท) ไม่ต้องกรอกฟอร์ม</p>
          {isLead && teamOut.length > 0 && <p className="note">จะส่งงานให้ลูกทีมที่ลงเวลาไว้ด้วย: {teamOut.map((c) => c.full_name).join(', ')}</p>}
          <ShotInput label="ถ่ายรูปงานที่ทำเสร็จ" max={5} shots={work.shots} onFiles={work.add} onRemove={work.remove} />
          <div className="row"><input className="inp" style={{ flex: 1 }} placeholder="ทำอะไรเสร็จ เช่น เปลี่ยนก๊อกห้อง 304 เสร็จ" value={doneNote} onChange={(e) => setDoneNote(e.target.value)} /></div>
          <div className="row">
            <select className="inp" value={workType} onChange={(e) => setWorkType(e.target.value)}>
              <option value="routine">ซ่อมประจำ</option><option value="renovation">สร้าง/ปรับปรุงห้อง</option><option value="project">งานโครงการ</option>
            </select>
            <input className="inp" style={{ width: 90 }} placeholder="ห้อง" value={room} onChange={(e) => setRoom(e.target.value)} />
          </div>
          <div className="row"><button className="btn" disabled={busy} onClick={() => doCheckOut(teamOut.map((c) => c.id))}>{busy ? 'กำลังส่ง…' : 'ส่งงาน'}</button></div>
        </div>
      )}

      <div className="panel">
        <h2>ขอเบิกค่าวัสดุ</h2>
        <div className="row">
          <input className="inp" style={{ flex: 1, minWidth: 150 }} placeholder="ร้าน / รายการ" value={mat.shop} onChange={(e) => setMat({ ...mat, shop: e.target.value })} />
          <input className="inp" type="number" inputMode="decimal" style={{ width: 100 }} placeholder="บาท" value={mat.amount} onChange={(e) => setMat({ ...mat, amount: e.target.value })} />
          <ProjectSelect value={mat.project} onChange={(v) => setMat({ ...mat, project: v })} projects={P} />
        </div>
        <ShotInput label="ถ่ายรูปใบเสร็จ" max={1} shots={receipt.shots} onFiles={receipt.add} onRemove={receipt.remove} />
        <div className="row"><button className="btn ghost" disabled={busy} onClick={doMaterial}>ส่งขอเบิกวัสดุ</button></div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ประวัติของฉัน
interface Claim { id: string; work_date: string; description: string; amount: number; line_status: string; request_no: number | null; request_status: string | null; reject_note: string | null; proof: string[] | null }

function claimStatus(c: Claim): [string, string] {
  if (c.line_status === 'rejected') return ['ไม่อนุมัติ', 'var(--out)']
  if (c.line_status === 'claimed') return ['รอเป้อยืนยัน', 'var(--A)']
  if (c.request_status === 'rejected') return ['ไม่อนุมัติ', 'var(--out)']
  if (['paid', 'asked', 'audited'].includes(c.request_status || '')) return ['จ่ายแล้ว', 'var(--in)']
  return ['รอจ่าย', 'var(--hi)']
}

export function CrewHistory() {
  const claims = useLive<Claim[]>(async () => {
    const { data, error } = await supabase.rpc('my_claims', { p_days: 60 })
    if (error) throw error
    return (data || []).map((c: Claim) => ({ ...c, amount: Number(c.amount) }))
  }, ['request_lines', 'requests', 'attachments'])
  const att = useLive<Att[]>(async () => {
    const { data, error } = await supabase.from('v_attendance').select('*').order('work_date', { ascending: false }).limit(31)
    if (error) throw error
    return data as Att[]
  }, ['attendance'])
  if (!claims.data || !att.data) return <Loading error={claims.error || att.error} />
  const paid = claims.data.filter((c) => claimStatus(c)[0] === 'จ่ายแล้ว').reduce((s, c) => s + c.amount, 0)
  const waiting = claims.data.filter((c) => ['รอเป้อยืนยัน', 'รอจ่าย'].includes(claimStatus(c)[0])).reduce((s, c) => s + c.amount, 0)
  return (
    <>
      <QueueBanner />
      <div className="panel">
        <div className="grid-stats">
          <div className="stat"><b className="ok">{fmt(paid)}</b><span>จ่ายแล้ว (60 วัน)</span></div>
          <div className="stat"><b>{fmt(waiting)}</b><span>รอยืนยัน / รอจ่าย</span></div>
        </div>
      </div>
      <div className="panel">
        <h2>ค่าแรงและค่าวัสดุของฉัน</h2>
        {!claims.data.length && <p className="muted">ยังไม่มีรายการ</p>}
        {claims.data.map((c) => {
          const [label, color] = claimStatus(c)
          return (
            <div key={c.id} className="py-1.5" style={{ borderTop: '1px dashed var(--line)' }}>
              <div className="flex justify-between gap-2">
                <span>{thaiDate(c.work_date)} · {c.description}</span>
                <span className="tabular-nums"><b>{fmt(c.amount)}</b> <span className="tag" style={{ borderColor: color, color }}>{label}</span></span>
              </div>
              {c.request_no && <span className="muted text-xs">ใบเบิก R{c.request_no}</span>}
              {c.reject_note && <div className="flag">เหตุผล: {c.reject_note}</div>}
              {c.proof?.length ? <Thumbs paths={c.proof} label="หลักฐานจ่าย" /> : null}
            </div>
          )
        })}
      </div>
      <div className="panel">
        <h2>ลงเวลางาน 31 วันล่าสุด</h2>
        <table className="t"><tbody>
          {att.data.map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap">{thaiDate(a.work_date)}</td>
              <td>{a.project_name}<div className="muted text-xs">{a.work_note}</div></td>
              <td className="whitespace-nowrap">{new Date(a.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}–{a.checkout_at ? new Date(a.checkout_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '…'}</td>
              <td>{a.flags.includes('no_gps') ? <span className="flag">ไม่มีพิกัด</span> : a.flags.includes('far') ? <span className="flag">ห่าง {fmt(a.distance_m)} ม.</span> : <span className="ok">ที่หน้างาน</span>}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </>
  )
}
