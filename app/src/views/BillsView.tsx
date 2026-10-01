// บิลค่าห้อง — import Excel → validation report → issue → LINE text → receipts / penalties / adjustments / deposits.
// Mirrors prototype VIEWS['บิลค่าห้อง']. All writes are RPCs; the table updates live for everyone.
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, rpc } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, fmtPhone, thaiDate, todayTH, daysBetween, round2 } from '../lib/format'
import type { RoundPayload } from '../lib/importer'
import { computeRound, FLAG_TH, type MeterFlag, type RoundPreview } from '../lib/billing'
import { billText, type BillView } from '../lib/billText'
import { uploadPhoto } from '../lib/photos'
import { num, numOrNull, type BillRow, type Profile, type Round } from '../lib/types'
import { Loading, Modal, Stat, useAction, useToast } from '../components/ui'

type Filter = 'all' | 'N' | 'P'
const flagTh = (f: string) => FLAG_TH[f as MeterFlag] || f

function toView(b: BillRow): BillView {
  return {
    code: b.rooms.code, building: b.rooms.building_id, status: b.status, tenant: b.tenant_name,
    rent: num(b.rent),
    elec: { prev: numOrNull(b.elec_prev), curr: numOrNull(b.elec_curr), units: numOrNull(b.elec_units), rate: num(b.elec_rate), amount: num(b.elec_amount) },
    water: { prev: numOrNull(b.water_prev), curr: numOrNull(b.water_curr), units: numOrNull(b.water_units), rate: num(b.water_rate), amount: num(b.water_amount), flat: b.water_is_flat },
    service: num(b.service), discount: num(b.discount), penalty: num(b.penalty), carryIn: num(b.carry_in), total: num(b.total),
    items: (b.bill_items || []).map((i) => ({ description: i.description, amount: num(i.amount) })),
  }
}

export default function BillsView({ profile }: { profile: Profile }) {
  const role = profile.role
  const canBill = ['manager', 'finance_field', 'ceo'].includes(role)
  const canRecv = ['finance', 'ceo'].includes(role)
  const canPenalty = ['manager', 'finance_field', 'ceo'].includes(role)
  const canRegs = ['finance_field', 'finance', 'ceo'].includes(role)

  const [roundId, setRoundId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [report, setReport] = useState<{ payload: RoundPayload; preview: RoundPreview } | null>(null)
  const [parseErrors, setParseErrors] = useState<string[] | null>(null)
  const { busy, run } = useAction()

  const rounds = useLive<Round[]>(async () => {
    const { data, error } = await supabase.from('bill_rounds').select('*').order('due_date', { ascending: false }).order('created_at', { ascending: false })
    if (error) throw error
    return data as Round[]
  }, ['bill_rounds'])
  const R = rounds.data?.find((r) => r.id === roundId) || rounds.data?.[0] || null

  const bills = useLive<BillRow[]>(async () => {
    if (!R) return []
    const { data, error } = await supabase.from('bills')
      .select('*, rooms(code, building_id, status, base_rent), bill_items(description, amount, source, reason)')
      .eq('round_id', R.id)
    if (error) throw error
    return data as unknown as BillRow[]
  }, ['bills', 'bill_items'], [R?.id])

  async function onFile(f: File | undefined) {
    if (!f) return
    const { parseWorkbook } = await import('../lib/importer') // SheetJS is big: load only when importing
    const { payload, errors } = parseWorkbook(new Uint8Array(await f.arrayBuffer()))
    if (!payload) { setParseErrors(errors); return }
    setReport({ payload, preview: computeRound(payload, { elec: R?.rates.elec ?? 8, water: R?.rates.water ?? 30 }) })
  }

  if (rounds.error) return <Loading error={rounds.error} />
  if (!rounds.data) return <Loading />

  const all = bills.data || []
  const B = all.filter((b) => filter === 'all' || b.rooms.building_id === filter)
  const sum = (f: (b: BillRow) => number, list = B) => round2(list.reduce((s, b) => s + f(b), 0))
  const left = (b: BillRow) => Math.max(0, round2(num(b.total) - num(b.paid)))
  const late = R ? Math.max(0, daysBetween(R.due_date, todayTH())) : 0
  const blocking = all.filter((b) => b.rooms.status === 'occupied' && b.flags.includes('missing_elec'))
  const flagged = all.filter((b) => b.flags.length)
  const order: Record<string, number> = { open: 0, welfare: 1, closed: 1, vacant: 2 }
  const sorted = [...B].sort((a, b) => (b.flags.length ? 1 : 0) - (a.flags.length ? 1 : 0) || order[a.status] - order[b.status] || a.rooms.code.localeCompare(b.rooms.code, 'th', { numeric: true }))
  const openBill = all.find((b) => b.id === open)

  return (
    <>
      <div className="panel">
        <div className="flex flex-wrap justify-between gap-3 items-start mb-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="m-0">{R ? `รอบบิล ${R.label}${R.meter_month ? ` (มิเตอร์ ${R.meter_month})` : ''}` : 'ยังไม่มีรอบบิล'}</h2>
              {rounds.data.length > 1 && (
                <select className="inp" value={R?.id} onChange={(e) => { setRoundId(e.target.value); setOpen(null) }} aria-label="เลือกรอบบิล">
                  {rounds.data.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              )}
            </div>
            {R && (
              <span className="muted">
                ครบกำหนด {thaiDate(R.due_date)} · {R.status === 'draft' ? 'ยังไม่วางบิล' : R.status === 'issued' ? 'วางบิลแล้ว' : 'ปิดรอบแล้ว'}
                {R.status === 'draft' && blocking.length > 0 && <> · <span className="flag">ยังไม่จดไฟ {blocking.length} ห้อง — จดให้ครบก่อนวางบิล</span></>}
              </span>
            )}
          </div>
          <div className="row" style={{ marginTop: 0 }}>
            {canBill && (
              <label className="btn">
                นำเข้าแบบฟอร์ม Excel
                <input type="file" accept=".xlsx" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
              </label>
            )}
            {canBill && R?.status === 'draft' && (
              <button className="btn" disabled={busy || blocking.length > 0}
                      onClick={() => confirm(`วางบิลรอบ ${R.label} ทั้งรอบ? หลังวางบิลจะนำเข้าซ้ำไม่ได้`) &&
                        run(() => rpc('issue_round', { p_round: R.id }), 'วางบิลทั้งรอบแล้ว — กดเลขห้องเพื่อคัดลอกบิลส่งผู้เช่า')}>
                วางบิลทั้งรอบ
              </button>
            )}
          </div>
        </div>

        {R && (
          <>
            <div className="tabs" style={{ marginBottom: 10 }}>
              {([['all', 'ทั้งหมด'], ['N', 'นารา'], ['P', 'ปรายดาว']] as [Filter, string][]).map(([k, v]) => (
                <button key={k} className="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{v}</button>
              ))}
            </div>
            <div className="grid-stats">
              <Stat value={fmt(sum((b) => (b.status === 'vacant' ? 0 : num(b.total))))} label={`ยอดวางบิล ${B.filter((b) => b.status !== 'vacant').length} ห้อง`} />
              <Stat value={fmt(sum((b) => num(b.paid)))} label={`รับแล้ว · ปิด ${B.filter((b) => b.status === 'closed').length} ห้อง`} tone="ok" />
              <Stat value={fmt(sum((b) => (b.status === 'open' ? left(b) : 0)))} label={`ค้าง ${B.filter((b) => b.status === 'open').length} ห้อง`} tone="bad" />
              <Stat value={flagged.length} label="ห้องที่ต้องตรวจมิเตอร์" tone={flagged.length ? 'bad' : undefined} />
              <Stat value={B.filter((b) => b.status === 'vacant').length} label="ห้อง/พื้นที่ว่าง" />
            </div>

            {!bills.data ? <p className="muted mt-3">กำลังโหลดบิล…</p> : (
              <div className="scroll mt-3">
                <table className="t">
                  <thead><tr><th>ห้อง</th><th className="n">ค่าเช่า</th><th className="n">ไฟ</th><th className="n">น้ำ</th><th className="n">อื่น/ปรับ</th><th className="n">รวม</th><th className="n">รับแล้ว</th><th>สถานะ</th></tr></thead>
                  <tbody>
                    {sorted.map((b) => (
                      <tr key={b.id} className={b.status}>
                        <td>
                          <button className="lnk" onClick={() => setOpen(b.id === open ? null : b.id)}>{b.rooms.code}</button>
                          {b.tenant_name && <div className="muted text-xs">{b.tenant_name}</div>}
                          {b.flags.map((f) => <div key={f} className="flag text-xs">{flagTh(f)}</div>)}
                        </td>
                        <td className="n">{fmt(b.rent)}</td>
                        <td className="n">{fmt(b.elec_amount)}</td>
                        <td className="n">{fmt(b.water_amount)}{b.water_is_flat ? <span className="muted"> เหมา</span> : null}</td>
                        <td className="n">{fmt(num(b.service) - num(b.discount) + num(b.items_total) + num(b.penalty) + num(b.carry_in))}</td>
                        <td className="n"><b>{fmt(b.total)}</b></td>
                        <td className="n">{fmt(b.paid)}</td>
                        <td>{statusText(b, R, late)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {openBill && <BillPanel key={openBill.id} b={openBill} R={R} canRecv={canRecv} canPenalty={canPenalty} late={late} onClose={() => setOpen(null)} />}
          </>
        )}
        <p className="muted mt-2">
          {canBill && 'เป้อ/นุ้ย: นำเข้าแบบฟอร์ม Excel → ตรวจห้องที่ขึ้นเตือน → วางบิล → กดเลขห้องเพื่อคัดลอกข้อความบิลส่ง LINE ผู้เช่า · '}
          {canRecv && 'กวาง: กด "ได้รับเงินแล้ว" = ห้องนั้นปิดรอบนี้ เงินเข้าบัญชีอาคารอัตโนมัติ · รับไม่ครบได้'}
          {!canBill && !canRecv && 'ดูอย่างเดียว'}
        </p>
      </div>

      {canRegs && <RegistrationsPanel />}
      {canRecv && <DepositsPanel />}

      {parseErrors && (
        <Modal title="นำเข้าไม่ได้ — แก้ไฟล์ก่อน" onClose={() => setParseErrors(null)}>
          <ul className="list-disc pl-5">{parseErrors.map((e, i) => <li key={i} className="flag">{e}</li>)}</ul>
        </Modal>
      )}
      {report && (
        <ImportReport report={report} existing={rounds.data.find((r) => r.label === report.payload.settings.label) || null}
                      onClose={() => setReport(null)}
                      onDone={(id) => { setReport(null); setRoundId(id); setOpen(null) }} />
      )}
    </>
  )
}

function statusText(b: BillRow, R: Round, late: number) {
  if (b.status === 'welfare') return <span className="muted">สวัสดิการพนักงาน (ไม่รับเงินจริง)</span>
  if (b.status === 'vacant') return <span className="muted">ว่าง</span>
  if (b.status === 'closed') return <span className="ok">ปิดแล้ว ✓</span>
  if (num(b.paid) > 0) return <span className="flag">จ่ายบางส่วน</span>
  if (R.status === 'draft') return <span className="muted">เตรียมบิล</span>
  return late > 0 ? <span className="flag">ค้าง {late} วัน</span> : <span className="muted">รอชำระ</span>
}

// ---------------------------------------------------------------- validation report before commit
function ImportReport({ report, existing, onClose, onDone }: {
  report: { payload: RoundPayload; preview: RoundPreview }; existing: Round | null
  onClose: () => void; onDone: (roundId: string) => void
}) {
  const { payload, preview } = report
  const { busy, run } = useAction()
  const t = preview.totals
  const flagged = preview.bills.filter((b) => b.flags.length)
  const locked = existing && existing.status !== 'draft'
  return (
    <Modal title={`ตรวจก่อนนำเข้า · รอบบิล ${payload.settings.label}`} onClose={onClose}>
      <p className="muted">ครบกำหนด {thaiDate(payload.settings.due_date)} · {payload.rooms.length} ห้อง · ค่าไฟ {payload.settings.elec_rate ?? 8}/หน่วย · ค่าน้ำ {payload.settings.water_rate ?? 30}/หน่วย</p>
      {locked && <p className="flag">รอบบิลนี้วางบิลไปแล้ว นำเข้าซ้ำไม่ได้ — ถ้าต้องแก้ ให้กวางเพิ่มรายการปรับในบิลห้องนั้น</p>}
      {existing && !locked && <p className="note">มีร่างรอบบิลชื่อเดียวกันอยู่แล้ว — นำเข้าครั้งนี้จะแทนที่ร่างเดิมทั้งหมด</p>}

      <div className="grid-stats my-3">
        <Stat value={fmt(t.N)} label="นารา" />
        <Stat value={fmt(t.P)} label="ปรายดาว" />
        <Stat value={fmt(t.all)} label="รวมวางบิล" />
      </div>
      <table className="t mb-3"><tbody>
        {([['ค่าเช่า', t.rent], ['ค่าไฟ', t.elec], ['ค่าน้ำ', t.water], ['ค่าบริการประจำ', t.service], ['ส่วนลดประจำ', -t.discount], ['รายการเพิ่มรอบนี้', t.items], ['ค้างยกมา', t.carry]] as [string, number][])
          .map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{fmt(v)}</td></tr>)}
      </tbody></table>
      <p className="muted">ตัวเลขนี้ควรตรงกับแท็บ "สรุปบิล" ในไฟล์ — ถ้าไม่ตรง ให้ตรวจก่อนกดนำเข้า</p>

      {preview.blocking.length > 0 && (
        <div className="al high"><b>ยังไม่จดไฟ {preview.blocking.length} ห้อง — นำเข้าได้ แต่วางบิลไม่ได้จนกว่าจะจดครบ</b><div className="muted">{preview.blocking.join(', ')}</div></div>
      )}
      {flagged.length > 0 && (
        <div className="al mid"><b>มิเตอร์ต้องตรวจ {flagged.length} ห้อง</b>
          <div className="muted">{flagged.map((b) => `${b.code} (${b.flags.map(flagTh).join(', ')})`).join(' · ')}</div></div>
      )}
      {preview.warnings.map((w, i) => (
        <div key={i} className="al high"><b>แท็บ {w.sheet}: {w.room}{w.amount != null ? ` · ${fmt(w.amount)} บาท` : ''}</b><div className="muted">{w.message}</div></div>
      ))}

      <div className="row mt-3">
        <button className="btn" disabled={busy || !!locked}
                onClick={() => run(async () => {
                  const r = await rpc<{ round_id: string; totals: { all: number } }>('import_round', { payload })
                  if (Math.abs(Number(r.totals.all) - t.all) > 0.005) throw new Error(`ยอดจากเซิร์ฟเวอร์ (${fmt(r.totals.all)}) ไม่ตรงกับที่ตรวจ (${fmt(t.all)}) — แจ้งผู้ดูแลระบบ`)
                  onDone(r.round_id)
                  return r
                }, `นำเข้า ${payload.rooms.length} ห้องแล้ว (ยังไม่วางบิล)`)}>
          ยืนยันนำเข้า (เป็นร่าง ยังไม่วางบิล)
        </button>
        <button className="btn ghost" onClick={onClose}>ยกเลิก</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- one bill
function BillPanel({ b, R, canRecv, canPenalty, late, onClose }: {
  b: BillRow; R: Round; canRecv: boolean; canPenalty: boolean; late: number; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  const toast = useToast()
  const { busy, run } = useAction()
  const remaining = Math.max(0, round2(num(b.total) - num(b.paid)))
  const [amt, setAmt] = useState(String(remaining))
  const [onDate, setOnDate] = useState(todayTH())
  const [slip, setSlip] = useState<File | null>(null)
  const suggested = Math.max(0, Math.min(R.rates.pen_max ?? 3100, late * (R.rates.pen_day ?? 100)) - num(b.penalty))
  const [pen, setPen] = useState(suggested ? String(suggested) : '')
  const [adj, setAdj] = useState({ description: '', amount: '', reason: '' })

  const text = useMemo(() => billText(toView(b), {
    label: R.label, due_date: R.due_date, names: R.bill_info.names || {}, bank: R.bill_info.bank || {}, contact: R.bill_info.contact || null,
  }, num(b.paid)), [b, R])

  async function copy() {
    try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว วางในแชท LINE ของผู้เช่าได้เลย') }
    catch { toast('คัดลอกไม่ได้ — กดค้างที่ข้อความแล้วเลือกคัดลอก', true) }
  }

  const issued = R.status === 'issued'
  return (
    <div className="bill" ref={ref}>
      <div className="flex justify-between items-start gap-2 mb-2">
        <b>บิลห้อง {b.rooms.code}{b.flags.length ? <span className="flag"> · {b.flags.map(flagTh).join(', ')}</span> : null}</b>
        <button className="btn ghost sm" onClick={onClose}>ปิด</button>
      </div>
      <textarea rows={Math.min(18, text.split('\n').length + 1)} readOnly value={text} aria-label="ข้อความบิลสำหรับ LINE" />
      <div className="row">
        <button className="btn" onClick={copy}>คัดลอกข้อความ ส่ง LINE ผู้เช่า</button>
        {b.tenant_phone && <span className="muted">โทร {fmtPhone(b.tenant_phone)}</span>}
      </div>

      {canRecv && issued && b.status === 'open' && (
        <>
          <h3>ได้รับเงิน · ค้าง {fmt(remaining)} บาท</h3>
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" min="0" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ width: 120 }} aria-label="จำนวนเงินที่ได้รับ" />
            <input className="inp" type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} aria-label="วันที่รับเงิน" />
            <label className="btn ghost sm">{slip ? 'มีสลิปแล้ว ✓' : 'แนบสลิป (ถ้ามี)'}
              <input type="file" accept="image/*" hidden onChange={(e) => setSlip(e.target.files?.[0] || null)} />
            </label>
            <button className="btn" disabled={busy || !(Number(amt) > 0)}
                    onClick={() => run(async () => {
                      const slipPath = slip ? await uploadPhoto(slip, `slips/${b.id}`) : null
                      return rpc<{ status: string; remaining: number }>('record_receipt', { p_bill: b.id, p_amount: Number(amt), p_on_date: onDate, p_slip_path: slipPath })
                    }, (r) => r.status === 'closed' ? `ปิดห้อง ${b.rooms.code} รอบนี้แล้ว` : `รับบางส่วน ${b.rooms.code} ค้างอีก ${fmt(r.remaining)}`)}>
              ได้รับเงินแล้ว
            </button>
          </div>
        </>
      )}

      {canPenalty && issued && b.status === 'open' && (
        <>
          <h3>ค่าปรับชำระล่าช้า{late > 0 ? ` · เลยกำหนด ${late} วัน` : ''}</h3>
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" min="0" value={pen} placeholder="บาท" onChange={(e) => setPen(e.target.value)} style={{ width: 110 }} aria-label="ค่าปรับ" />
            <button className="btn ghost" disabled={busy || !(Number(pen) > 0)}
                    onClick={() => run(() => rpc('add_penalty', { p_bill: b.id, p_amount: Number(pen) }), `เพิ่มค่าปรับ ${b.rooms.code} ${fmt(pen)}`)}>
              ใส่ค่าปรับ
            </button>
            <span className="muted">กฎ: {R.rates.pen_day}/วัน สูงสุด {fmt(R.rates.pen_max)} · ใส่ไปแล้ว {fmt(b.penalty)}</span>
          </div>
        </>
      )}

      {canRecv && R.status !== 'closed' && b.status !== 'vacant' && (
        <>
          <h3>ปรับบิล (เก็บเพิ่ม + / ส่วนลด −)</h3>
          <div className="row">
            <input className="inp" placeholder="รายการ" value={adj.description} onChange={(e) => setAdj({ ...adj, description: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
            <input className="inp" type="number" inputMode="decimal" placeholder="บาท" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} style={{ width: 100 }} />
            <input className="inp" placeholder={issued ? 'เหตุผล (ต้องใส่)' : 'เหตุผล'} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
            <button className="btn ghost" disabled={busy || !adj.description || !Number(adj.amount)}
                    onClick={() => run(async () => {
                      await rpc('add_bill_item', { p_bill: b.id, p_description: adj.description, p_amount: Number(adj.amount), p_reason: adj.reason })
                      setAdj({ description: '', amount: '', reason: '' })
                    }, 'ปรับบิลแล้ว')}>
              บันทึก
            </button>
          </div>
        </>
      )}
      {(b.bill_items || []).some((i) => i.source === 'adjustment') && (
        <p className="muted mt-2">ประวัติการปรับ: {b.bill_items.filter((i) => i.source === 'adjustment').map((i) => `${i.description} ${fmt(i.amount)}${i.reason ? ` (${i.reason})` : ''}`).join(' · ')}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- tenant self-registration (approve)
interface Reg { id: string; name: string; phone: string; line_id: string | null; emergency_name: string; emergency_phone: string; created_at: string; rooms: { code: string } }

function RegistrationsPanel() {
  const { busy, run } = useAction()
  const regs = useLive<Reg[]>(async () => {
    const { data, error } = await supabase.from('tenant_registrations')
      .select('id, name, phone, line_id, emergency_name, emergency_phone, created_at, rooms(code)')
      .eq('status', 'pending').order('created_at')
    if (error) throw error
    return data as unknown as Reg[]
  }, ['tenant_registrations'])
  if (!regs.data?.length) return null
  return (
    <div className="panel">
      <h2>ผู้เช่าลงทะเบียนใหม่ รอตรวจ ({regs.data.length})</h2>
      <p className="muted">ผู้เช่ากรอกเองผ่านลิงก์/QR ของห้อง · ตรวจกับตัวจริงแล้วกดอนุมัติ ชื่อจะขึ้นในบิล</p>
      {regs.data.map((r) => (
        <div key={r.id} className="al mid">
          <b>ห้อง {r.rooms.code} · {r.name}</b> <span className="muted">{thaiDate(r.created_at.slice(0, 10))}</span>
          <div className="muted">โทร {fmtPhone(r.phone)}{r.line_id ? ` · LINE ${r.line_id}` : ''} · ฉุกเฉิน {r.emergency_name} {fmtPhone(r.emergency_phone)}</div>
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={() => run(() => rpc('decide_tenant_registration', { p_id: r.id, p_approve: true }), `อนุมัติผู้เช่าห้อง ${r.rooms.code} แล้ว`)}>อนุมัติ</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => {
              const note = prompt('เหตุผลที่ไม่อนุมัติ') ?? ''
              run(() => rpc('decide_tenant_registration', { p_id: r.id, p_approve: false, p_note: note }), 'ไม่อนุมัติแล้ว')
            }}>ไม่อนุมัติ</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- deposits (liability, never revenue)
function DepositsPanel() {
  const { busy, run } = useAction()
  const [f, setF] = useState({ room: '', kind: 'deposit', amount: '', date: todayTH() })
  const held = useLive<number>(async () => {
    const { data, error } = await supabase.from('v_deposits_held').select('held')
    if (error) throw error
    return round2((data || []).reduce((s, r) => s + num(r.held), 0))
  }, ['deposits'])
  return (
    <div className="panel">
      <h2>เงินประกัน / เงินจอง (ไม่ใช่รายได้)</h2>
      <div className="row">
        <input className="inp" placeholder="ห้อง เช่น 406 หรือ B201" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} style={{ width: 160 }} />
        <select className="inp" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="deposit">เงินประกัน</option><option value="booking">เงินจอง</option><option value="refund">คืนเงินประกัน</option>
        </select>
        <input className="inp" type="number" inputMode="decimal" placeholder="บาท" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ width: 110 }} />
        <input className="inp" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <button className="btn" disabled={busy || !f.room || !(Number(f.amount) > 0)}
                onClick={() => run(async () => {
                  await rpc('record_deposit', { p_room_code: f.room.trim(), p_kind: f.kind, p_amount: Number(f.amount), p_on_date: f.date })
                  setF({ ...f, room: '', amount: '' })
                }, 'บันทึกแล้ว')}>
          บันทึก
        </button>
      </div>
      <p className="muted">ผู้เช่าใหม่ลง 2 รายการ: ค่าห้องเดือนแรก (ในบิล) + เงินประกัน (ตรงนี้) · ถืออยู่ทั้งหมด <b>{held.data == null ? '…' : fmt(held.data)}</b> บาท</p>
    </div>
  )
}
