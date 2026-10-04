// One ใบเบิก card — same layout as prototype reqCard(): type, R-number, date, status, total, lines with project tags,
// 4-step trail (ขอ · อนุมัติ · จ่าย · ตรวจ), photos, flags, question/answer, and an actions slot.
import type { ReactNode } from 'react'
import { fmt, thaiDate } from '../lib/format'
import { FLAG_TH, ROLE_PERSON, STATUS_TH, TYPE_TH, WALLET_TH, WORKTYPE_TH, type Project, type Req } from '../lib/requests'
import { Thumbs } from './Photos'

const KIND_TAG: Record<string, string> = { dorm: '', capex: 'A', shared: 'C', real_estate: 'R' }

export function ProjectTag({ id, projects }: { id: string; projects: Project[] }) {
  const p = projects.find((x) => x.id === id)
  const cls = p ? (p.kind === 'dorm' ? (p.building_id === 'P' ? 'B' : 'A') : KIND_TAG[p.kind]) : ''
  const style = p?.kind === 'real_estate' ? { borderColor: 'var(--re)', color: 'var(--re)' } : p?.kind === 'shared' ? { borderColor: 'var(--hi)', color: 'var(--hi)' } : undefined
  return <span className={`tag ${cls}`} style={style}>{p?.name || id}</span>
}

function Trail({ r }: { r: Req }) {
  const s = r.status
  const steps: [string, string, string][] = [
    ['ขอ', r.requester_name || '—', 'done'],
    ['อนุมัติ', r.approver_name || ROLE_PERSON[r.approver_role] || '', s === 'to_approve' ? 'now' : s === 'rejected' ? 'ask' : 'done'],
    ['จ่าย', r.payer_name || ROLE_PERSON[r.payer_role] || '', s === 'to_approve' || s === 'rejected' ? '' : s === 'to_pay' ? 'now' : 'done'],
    ['ตรวจ', r.auditor_name || 'กวาง/หน่อย', s === 'audited' ? 'done' : s === 'asked' ? 'ask' : s === 'paid' ? 'now' : ''],
  ]
  return (
    <div className="flex flex-wrap my-2">
      {steps.map(([a, b, c], i) => (
        <span key={a} className="text-xs px-2.5 py-0.5 border"
              style={{
                borderColor: c === 'done' ? 'var(--in)' : c === 'ask' ? 'var(--out)' : c === 'now' ? 'var(--ink)' : 'var(--line)',
                background: c === 'done' ? 'var(--in)' : c === 'ask' ? 'var(--out)' : c === 'now' ? 'var(--card)' : 'var(--paper)',
                color: c === 'done' || c === 'ask' ? '#fff' : c === 'now' ? 'var(--ink)' : 'var(--mute)',
                fontWeight: c === 'now' ? 600 : 400,
                borderRadius: i === 0 ? '6px 0 0 6px' : i === 3 ? '0 6px 6px 0' : 0,
                borderLeftWidth: i === 0 ? 1 : 0,
              }}>
          {a} · {b}
        </span>
      ))}
    </div>
  )
}

export default function RequestCard({ r, projects, children }: { r: Req; projects: Project[]; children?: ReactNode }) {
  const work = r.attachments.filter((a) => a.kind === 'work').map((a) => a.path)
  const receipts = r.attachments.filter((a) => a.kind === 'receipt').map((a) => a.path)
  const proof = r.attachments.filter((a) => a.kind === 'payment_proof').map((a) => a.path)
  return (
    <div className="panel" style={{ padding: '12px 14px', marginBottom: 10 }}>
      <div className="flex justify-between gap-3 flex-wrap items-start mb-1">
        <div><b>{TYPE_TH[r.type]}</b> <span className="muted">R{r.no} · {thaiDate(r.work_date || r.created_at.slice(0, 10))} · {STATUS_TH[r.status]}</span></div>
        <div className="text-lg font-bold tabular-nums">{fmt(r.total)}</div>
      </div>
      <div className="text-[13px]">
        {r.lines.map((l, i) => (
          <div key={l.id} className="flex justify-between gap-2 py-0.5" style={{ borderTop: i ? '1px dashed var(--line)' : undefined }}>
            <span>
              {l.description}{l.room_code ? ` · ห้อง ${l.room_code}` : ''}
              <ProjectTag id={l.project_id} projects={projects} />
              {l.work_type && r.type !== 'salary' && r.type !== 'petty_refill' && <span className="tag">{WORKTYPE_TH[l.work_type]}</span>}
            </span>
            <span className="tabular-nums">{fmt(l.amount)}</span>
          </div>
        ))}
      </div>
      <Thumbs paths={work} label="รูปงาน" />
      <Thumbs paths={receipts} label="ใบเสร็จ" />
      <Trail r={r} />
      <div className="muted">จ่ายจาก {WALLET_TH[r.wallet_id] || r.wallet_id}{proof.length ? <> · <span className="ok">มีหลักฐานการจ่าย</span></> : null}</div>
      <Thumbs paths={proof} label="หลักฐานจ่าย" />
      {r.flags.map((f) => <div key={f} className="flag">⚑ {FLAG_TH[f] || f}</div>)}
      {r.status === 'rejected' && r.reject_note && <div className="note"><b>ไม่อนุมัติ:</b> {r.reject_note}</div>}
      {r.question && (
        <div className="note">
          <b>{r.asker_name || 'ผู้ตรวจ'}ถาม:</b> {r.question}
          {r.answer && <><br /><b>{r.requester_name}ตอบ:</b> {r.answer}</>}
        </div>
      )}
      {children}
    </div>
  )
}
