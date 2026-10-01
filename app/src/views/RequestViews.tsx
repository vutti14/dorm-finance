// Request queues: รายการของฉัน · รอจ่าย · รออนุมัติ · ตรวจสอบ · รายการทั้งหมด · เบิกเงินเดือน (prototype views)
import { useState } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt } from '../lib/format'
import { STATUS_TH, TYPE_TH, WALLET_TH, useProjects, useRequests, useWalletBalances, type Req, type ReqStatus } from '../lib/requests'
import type { Profile } from '../lib/types'
import RequestCard from '../components/RequestCard'
import { PhotoPicker, Thumbs } from '../components/Photos'
import { Loading, Stat, useAction } from '../components/ui'

function List({ reqs, empty, render }: { reqs: Req[] | null; empty: string; render: (r: Req) => React.ReactNode }) {
  const projects = useProjects()
  if (!reqs || !projects.data) return <Loading />
  if (!reqs.length) return <div className="panel muted">{empty}</div>
  return <>{reqs.map((r) => <RequestCard key={r.id} r={r} projects={projects.data!}>{render(r)}</RequestCard>)}</>
}

// ---------------------------------------------------------------- รายการของฉัน
export function MyRequests({ profile }: { profile: Profile }) {
  const q = useRequests((x) => x.eq('requester_id', profile.id), [profile.id])
  return <List reqs={q.data} empty="ยังไม่มีรายการ" render={(r) => r.status === 'asked' && !r.answer ? <Answer r={r} /> : null} />
}

function Answer({ r }: { r: Req }) {
  const [t, setT] = useState('')
  const { busy, run } = useAction()
  return (
    <div className="row">
      <input className="inp" style={{ flex: 1 }} placeholder="ตอบคำถาม" value={t} onChange={(e) => setT(e.target.value)} />
      <button className="btn" disabled={busy || !t.trim()} onClick={() => run(() => rpc('answer_question', { p_id: r.id, p_text: t }), 'ส่งคำตอบแล้ว')}>ส่งคำตอบ</button>
    </div>
  )
}

// ---------------------------------------------------------------- pay with proof
function PayBox({ r, approveToo }: { r: Req; approveToo?: boolean }) {
  const [proof, setProof] = useState<string[]>([])
  const { busy, run } = useAction()
  const slip = r.wallet_id === 'A3'
  return (
    <div className="row">
      <PhotoPicker label={slip ? 'แนบสลิปโอน' : 'ถ่ายรูปผู้รับเงิน/สลิป'} folder={`proof/${r.id}`} capture={!slip} onAdd={(p) => setProof([...proof, ...p])} />
      <Thumbs paths={proof} />
      <button className="btn" disabled={busy || !proof.length}
              onClick={() => run(() => rpc('pay_request', { p_id: r.id, p_proof_paths: proof }), approveToo ? `อนุมัติและโอน R${r.no} แล้ว` : `จ่าย R${r.no} แล้ว`)}>
        {approveToo ? `อนุมัติและโอนจาก${WALLET_TH[r.wallet_id]}` : 'จ่ายแล้ว'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- รอจ่าย
export function ToPay({ profile }: { profile: Profile }) {
  const q = useRequests((x) => {
    const y = x.eq('status', 'to_pay')
    return profile.role === 'ceo' ? y : y.eq('payer_role', profile.role)
  }, [profile.role])
  const bal = useWalletBalances()
  const [refill, setRefill] = useState('10000')
  const { busy, run } = useAction()
  return (
    <>
      <div className="panel">
        <div className="grid-stats">
          <Stat value={bal.data ? (bal.data.PC != null ? fmt(bal.data.PC) : 'ยังไม่ตั้งยอด') : '…'} label="เงินสำรองนุ้ยคงเหลือ" />
          <Stat value={q.data?.length ?? '…'} label="รายการรอจ่าย" />
        </div>
        {['finance_field', 'ceo'].includes(profile.role) && (
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" style={{ width: 120 }} value={refill} onChange={(e) => setRefill(e.target.value)} />
            <button className="btn ghost" disabled={busy || !(Number(refill) > 0)}
                    onClick={() => run(() => rpc<{ no: number }>('submit_request', { payload: { type: 'petty_refill', lines: [{ amount: Number(refill), project_id: 'SH' }] } }),
                      (r) => `ขอเติมเงินสำรอง R${r.no} แล้ว · รอกวางอนุมัติ`)}>ขอเติมเงินสำรอง</button>
          </div>
        )}
      </div>
      <List reqs={q.data} empty="ไม่มีรายการรอจ่าย" render={(r) => <PayBox r={r} />} />
    </>
  )
}

// ---------------------------------------------------------------- รออนุมัติ
export function ToApprove({ profile }: { profile: Profile }) {
  const q = useRequests((x) => {
    const y = x.eq('status', 'to_approve')
    return profile.role === 'ceo' ? y : y.eq('approver_role', profile.role)
  }, [profile.role])
  return <List reqs={q.data} empty="ไม่มีรายการรออนุมัติ" render={(r) => <ApproveBox r={r} profile={profile} />} />
}

function ApproveBox({ r, profile }: { r: Req; profile: Profile }) {
  const { busy, run } = useAction()
  const selfPay = r.payer_role === profile.role || profile.role === 'ceo' && r.payer_role === 'finance'
  return (
    <>
      {selfPay ? <PayBox r={r} approveToo /> : (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => run(() => rpc('approve_request', { p_id: r.id }), `อนุมัติ R${r.no} แล้ว ส่งให้นุ้ยจ่าย`)}>อนุมัติ ส่งให้นุ้ยจ่าย</button>
        </div>
      )}
      <div className="row">
        <button className="btn ghost sm" disabled={busy} onClick={() => {
          const note = prompt(`เหตุผลที่ไม่อนุมัติ R${r.no}`)
          if (note && note.trim()) run(() => rpc('reject_request', { p_id: r.id, p_note: note }), `ไม่อนุมัติ R${r.no}`)
        }}>ไม่อนุมัติ</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ตรวจสอบ
export function Audit() {
  const q = useRequests((x) => x.in('status', ['paid', 'asked']))
  const paid = (q.data || []).filter((r) => r.status === 'paid')
  const waiting = (q.data || []).filter((r) => r.status === 'asked')
  return (
    <>
      <div className="panel">
        <div className="grid-stats">
          <Stat value={paid.length} label="จ่ายแล้วรอตรวจ" />
          <Stat value={paid.filter((r) => r.flags.length).length} label="รายการมีธง" tone={paid.some((r) => r.flags.length) ? 'bad' : undefined} />
          <Stat value={waiting.length} label="รอคำตอบ" />
        </div>
        <p className="muted">กวางและหน่อยตรวจได้ทั้งคู่ ใครตรวจก่อนก็ได้ ระบบบันทึกชื่อคนตรวจ · ตอบคำถามแล้วรายการจะกลับมาให้ตรวจ</p>
      </div>
      <List reqs={q.data ? [...paid.sort((a, b) => b.flags.length - a.flags.length), ...waiting] : null} empty="ไม่มีรายการรอตรวจ"
            render={(r) => r.status === 'paid' ? <AuditBox r={r} /> : <p className="muted">รอ{r.requester_name}ตอบ</p>} />
    </>
  )
}

function AuditBox({ r }: { r: Req }) {
  const [qn, setQn] = useState('')
  const { busy, run } = useAction()
  return (
    <div className="row">
      <button className="btn" disabled={busy} onClick={() => run(() => rpc('audit_request', { p_id: r.id }), `ตรวจผ่าน R${r.no}`)}>ตรวจผ่าน</button>
      <input className="inp" style={{ flex: 1, minWidth: 160 }} placeholder="ถามคนขอเบิก" value={qn} onChange={(e) => setQn(e.target.value)} />
      <button className="btn warn" disabled={busy || !qn.trim()} onClick={() => run(() => rpc('ask_question', { p_id: r.id, p_text: qn }), `ส่งคำถามถึง${r.requester_name}แล้ว`)}>ส่งคำถาม</button>
    </div>
  )
}

// ---------------------------------------------------------------- รายการทั้งหมด
export function AllRequests() {
  const [st, setSt] = useState<'' | ReqStatus>('')
  const q = useRequests((x) => (st ? x.eq('status', st) : x), [st], 300)
  const total = (q.data || []).reduce((s, r) => s + r.total, 0)
  return (
    <>
      <div className="panel">
        <div className="row" style={{ marginTop: 0 }}>
          <select className="inp" value={st} onChange={(e) => setSt(e.target.value as ReqStatus | '')}>
            <option value="">ทุกสถานะ</option>
            {(Object.keys(STATUS_TH) as ReqStatus[]).map((k) => <option key={k} value={k}>{STATUS_TH[k]}</option>)}
          </select>
          <span className="muted">{q.data?.length ?? '…'} รายการ · รวม {fmt(total)} บาท</span>
        </div>
      </div>
      <List reqs={q.data} empty="ไม่มีรายการ" render={() => null} />
    </>
  )
}

// ---------------------------------------------------------------- เบิกเงินเดือน
interface Sal { profile_id: string; display_name: string; plan: number; drawn: number; pending: number; remaining: number }

export function Salary({ profile }: { profile: Profile }) {
  const [amt, setAmt] = useState('5000')
  const { busy, run } = useAction()
  const s = useLive<Sal | null>(async () => {
    const { data, error } = await supabase.rpc('salary_status')
    if (error) throw error
    const r = (data as Sal[])[0]
    return r ? { ...r, plan: Number(r.plan), drawn: Number(r.drawn), pending: Number(r.pending), remaining: Number(r.remaining) } : null
  }, ['requests', 'salary_plans'])
  const mine = useRequests((x) => x.eq('type', 'salary').eq('salary_for', profile.id), [profile.id], 24)
  const month = new Intl.DateTimeFormat('th-TH', { month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' }).format(new Date())
  if (!s.data) return <Loading error={s.error} />
  return (
    <>
      <div className="panel">
        <h2>เงินเดือน {month} · {profile.display_name}</h2>
        <div className="grid-stats">
          <Stat value={fmt(s.data.plan)} label="เงินเดือน" />
          <Stat value={fmt(s.data.drawn)} label="เบิกไปแล้ว" />
          <Stat value={fmt(s.data.pending)} label="รออนุมัติ" />
          <Stat value={fmt(s.data.remaining)} label="เบิกได้อีก" tone={s.data.remaining <= 0 ? 'bad' : 'ok'} />
        </div>
        {s.data.plan <= 0 ? <p className="flag mt-2">ยังไม่ได้ตั้งเงินเดือน — ให้อาร์ตตั้งในแท็บผู้ใช้งาน</p> : (
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" style={{ width: 120 }} value={amt} onChange={(e) => setAmt(e.target.value)} />
            <button className="btn" disabled={busy || !(Number(amt) > 0) || Number(amt) > s.data.remaining}
                    onClick={() => run(() => rpc<{ no: number }>('submit_request', { payload: { type: 'salary', lines: [{ amount: Number(amt), project_id: 'SH' }] } }),
                      (r) => `ขอเบิกเงินเดือน R${r.no} แล้ว · รอกวางอนุมัติ`)}>ขอเบิกเงินเดือน</button>
          </div>
        )}
        <p className="muted">กวางอนุมัติและโอนจากบัญชี3 · เลิกสมุดเงินเดือนแยก</p>
      </div>
      {mine.data?.length ? (
        <div className="panel">
          <h2>ประวัติเบิกเงินเดือน</h2>
          <table className="t"><tbody>
            {mine.data.map((r) => <tr key={r.id}><td>R{r.no}</td><td>{r.created_at.slice(0, 10)}</td><td>{STATUS_TH[r.status]}</td><td className="n">{fmt(r.total)}</td></tr>)}
          </tbody></table>
        </div>
      ) : null}
    </>
  )
}

export { TYPE_TH }
