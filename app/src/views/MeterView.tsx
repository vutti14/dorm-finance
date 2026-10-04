// จดมิเตอร์ (SPEC §7, M4): rooms by building → prev auto-filled from the last round → photo of the meter with the
// room sticker → AI reads the number (optional, the person confirms) → instant flag check → save → bill recomputed.
import { useMemo, useState } from 'react'
import { edge, rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, thaiDate } from '../lib/format'
import { FLAG_TH, type MeterFlag } from '../lib/billing'
import { parseReading, previewElec, previewWater } from '../lib/meter'
import { compressPhoto, uploadBlobAt } from '../lib/photos'
import { num, numOrNull, type Profile, type Round } from '../lib/types'
import { Thumbs } from '../components/Photos'
import { Loading, Modal, Stat, useAction, useToast } from '../components/ui'

interface SheetRow {
  room_id: string; code: string; building_id: 'N' | 'P'; room_status: string; tenant_name: string | null
  water_flat: number | null; elec_prev: number | null; elec_curr: number | null; elec_units: number | null
  prev_units: number | null; water_prev: number | null; water_curr: number | null; ai_value: number | null
  photo_path: string | null; read_by_name: string | null; read_at: string | null; flags: string[]; total: number
  elec_rate: number; water_rate: number; water_photo_path: string | null
}
interface AiResult {
  reading: number | null; digits_seen: string; room_label_seen: string | null
  confidence: 'high' | 'medium' | 'low'; problem: string | null; warnings: string[]
}
type Kind = 'elec' | 'water'

const STATUS_TH: Record<string, string> = { occupied: 'มีผู้เช่า', vacant: 'ว่าง', staff: 'ห้องพนักงาน', renovation: 'ปิดปรับปรุง' }
const flagTh = (f: string) => FLAG_TH[f as MeterFlag] || f
const BLD: Record<string, string> = { N: 'นารา', P: 'ปรายดาว' }

export default function MeterView({ profile }: { profile: Profile }) {
  const canWrite = ['manager', 'finance_field', 'ceo'].includes(profile.role)
  const [bld, setBld] = useState<'N' | 'P'>('N')
  const [onlyTodo, setOnlyTodo] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const round = useLive<{ draft: Round | null }>(async () => {
    const { data, error } = await supabase.from('bill_rounds').select('*').eq('status', 'draft').order('created_at', { ascending: false }).limit(1)
    if (error) throw error
    return { draft: (data?.[0] as Round) ?? null }
  }, ['bill_rounds'])
  const R = round.data?.draft ?? null

  const sheet = useLive<SheetRow[]>(async () => {
    if (!R) return []
    const { data, error } = await supabase.rpc('meter_sheet', { p_round: R.id })
    if (error) throw error
    return (data as SheetRow[]).map((r) => ({
      ...r, elec_prev: numOrNull(r.elec_prev), elec_curr: numOrNull(r.elec_curr), elec_units: numOrNull(r.elec_units),
      prev_units: numOrNull(r.prev_units), water_prev: numOrNull(r.water_prev), water_curr: numOrNull(r.water_curr),
      water_flat: numOrNull(r.water_flat), ai_value: numOrNull(r.ai_value), total: num(r.total),
      elec_rate: num(r.elec_rate), water_rate: num(r.water_rate),
    }))
  }, ['bills', 'meter_readings'], [R?.id])

  if (round.error) return <Loading error={round.error} />
  if (!round.data) return <Loading />
  if (!R) {
    return canWrite ? <StartRound /> : <div className="panel"><h2>จดมิเตอร์</h2><p className="muted">ยังไม่มีรอบบิลที่กำลังจด</p></div>
  }
  if (!R || !sheet.data) return <Loading error={sheet.error} />

  const rows = sheet.data
  const needs = (r: SheetRow) => r.elec_curr == null || (r.water_flat == null && r.water_curr == null && r.room_status !== 'vacant')
  const occTodo = rows.filter((r) => r.room_status === 'occupied' && r.elec_curr == null)
  const done = rows.filter((r) => r.elec_curr != null)
  const flagged = rows.filter((r) => r.flags.some((f) => f !== 'missing_elec' && f !== 'missing_water'))
  const list = rows.filter((r) => r.building_id === bld && (!onlyTodo || needs(r) || r.flags.length))
  const open = rows.find((r) => r.room_id === openId) || null
  const nextTodo = (after: SheetRow) => {
    const same = rows.filter((r) => r.building_id === after.building_id)
    const i = same.findIndex((r) => r.room_id === after.room_id)
    return [...same.slice(i + 1), ...same.slice(0, i)].find((r) => r.elec_curr == null) || null
  }

  return (
    <div>
      <div className="panel">
        <h2>จดมิเตอร์ · รอบบิล {R.label}{R.meter_month ? ` (มิเตอร์ ${R.meter_month})` : ''}</h2>
        <div className="grid-stats">
          <Stat value={`${done.length} / ${rows.length}`} label="ห้องที่จดไฟแล้ว" />
          <Stat value={occTodo.length} label="ห้องมีผู้เช่ายังไม่จด (วางบิลไม่ได้)" tone={occTodo.length ? 'bad' : 'ok'} />
          <Stat value={flagged.length} label="ห้องที่ต้องตรวจ" tone={flagged.length ? 'bad' : undefined} />
          <Stat value={thaiDate(R.due_date)} label="ครบกำหนดชำระ" />
        </div>
        <p className="muted mt-2 mb-0">ถ่ายรูปมิเตอร์ให้เห็นสติกเกอร์เลขห้อง → AI อ่านเลขให้ → ตรวจแล้วกดบันทึก (อ่านไม่ได้ก็พิมพ์เอง) · บิลห้องนั้นคำนวณใหม่ทันที · จดครบแล้วไปกด "วางบิล" ที่แท็บบิลค่าห้อง</p>
      </div>

      <div className="row mb-2">
        {(['N', 'P'] as const).map((b) => (
          <button key={b} className={`btn sm ${bld === b ? '' : 'ghost'}`} onClick={() => setBld(b)}>
            {BLD[b]} ({rows.filter((r) => r.building_id === b && r.elec_curr == null).length} ยังไม่จด)
          </button>
        ))}
        <label className="muted ml-auto"><input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} /> เฉพาะที่ยังไม่จด / ต้องตรวจ</label>
      </div>

      {list.length === 0 && <div className="panel"><span className="ok">จดครบแล้วทุกห้องใน{BLD[bld]}</span></div>}
      {list.map((r) => (
        <button key={r.room_id} className="panel w-full text-left block" style={{ cursor: canWrite ? 'pointer' : 'default' }}
                onClick={() => canWrite && setOpenId(r.room_id)}>
          <div className="flex justify-between gap-2 items-start">
            <div>
              <b>{r.code}</b> <span className="muted">{STATUS_TH[r.room_status]}{r.tenant_name ? ` · ${r.tenant_name}` : ''}</span>
              <div className="muted">
                ไฟ: {r.elec_prev ?? '—'} → {r.elec_curr ?? <span className="flag">ยังไม่จด</span>}
                {r.elec_units != null && <> = {fmt(r.elec_units)} หน่วย</>}
                {r.water_flat == null && <> · น้ำ: {r.water_prev ?? '—'} → {r.water_curr ?? '—'}</>}
                {r.water_flat != null && <> · น้ำเหมา {fmt(r.water_flat)}</>}
              </div>
              {r.flags.filter((f) => f !== 'missing_elec' && f !== 'missing_water').map((f) => <span key={f} className="flag mr-2">{flagTh(f)}</span>)}
            </div>
            <div className="text-right">
              <b>{fmt(r.total)}</b>
              <div className="muted text-xs">{r.read_by_name ? `${r.read_by_name}` : ''}</div>
            </div>
          </div>
        </button>
      ))}

      {open && <MeterEntry key={open.room_id} row={open} roundId={R.id}
                           onClose={() => setOpenId(null)} onNext={() => setOpenId(nextTodo(open)?.room_id ?? null)} />}
    </div>
  )
}

function StartRound() {
  const { busy, run } = useAction()
  const [f, setF] = useState({ label: '', meter_month: '', issue_date: '', due_date: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="panel">
      <h2>เริ่มรอบบิลใหม่</h2>
      <p className="muted">ระบบสร้างบิลทุกห้องจากข้อมูลห้อง/ผู้เช่าปัจจุบัน และดึง "เลขครั้งก่อน" จากรอบที่แล้วให้เอง จากนั้นจดมิเตอร์ทีละห้องได้เลย
        (ยังนำเข้าแบบฟอร์ม Excel ที่แท็บบิลค่าห้องได้เหมือนเดิม — เลขที่จดในแอปจะไม่หาย)</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <label className="muted">ชื่อรอบบิล<input className="inp w-full" placeholder="เช่น พ.ย. 69" value={f.label} onChange={set('label')} /></label>
        <label className="muted">เดือนที่จดมิเตอร์<input className="inp w-full" placeholder="เช่น ต.ค. 69" value={f.meter_month} onChange={set('meter_month')} /></label>
        <label className="muted">วันที่ออกบิล<input className="inp w-full" type="date" value={f.issue_date} onChange={set('issue_date')} /></label>
        <label className="muted">วันครบกำหนดชำระ<input className="inp w-full" type="date" value={f.due_date} onChange={set('due_date')} /></label>
      </div>
      <div className="row">
        <button className="btn" disabled={busy || !f.label.trim() || !f.due_date}
                onClick={() => run(() => rpc<{ rooms: number }>('start_round', {
                  p_label: f.label.trim(), p_meter_month: f.meter_month.trim() || null, p_issue_date: f.issue_date || null, p_due_date: f.due_date,
                }), (r) => `เริ่มรอบบิล ${f.label.trim()} แล้ว (${r.rooms} ห้อง)`)}>เริ่มรอบบิล</button>
      </div>
    </div>
  )
}

function MeterEntry({ row, roundId, onClose, onNext }: { row: SheetRow; roundId: string; onClose: () => void; onNext: () => void }) {
  const toast = useToast()
  const { busy, run } = useAction()
  const hasWaterMeter = row.water_flat == null
  const [kind, setKind] = useState<Kind>(row.elec_curr == null || !hasWaterMeter ? 'elec' : row.water_curr == null ? 'water' : 'elec')
  const [state, setState] = useState<Record<Kind, { text: string; prevText: string; photo: string | null; preview: string | null; ai: AiResult | null; reading: boolean }>>({
    elec: { text: row.elec_curr != null ? String(row.elec_curr) : '', prevText: '', photo: null, preview: null, ai: null, reading: false },
    water: { text: row.water_curr != null ? String(row.water_curr) : '', prevText: '', photo: null, preview: null, ai: null, reading: false },
  })
  const s = state[kind]
  const patch = (k: Kind, p: Partial<typeof s>) => setState((o) => ({ ...o, [k]: { ...o[k], ...p } }))

  const storedPrev = kind === 'elec' ? row.elec_prev : row.water_prev
  const prev = storedPrev ?? parseReading(s.prevText)
  const curr = parseReading(s.text)
  const pv = useMemo(() => kind === 'elec'
    ? previewElec({ prev, curr, prevUnits: row.prev_units, roomStatus: row.room_status, rate: row.elec_rate })
    : previewWater({ prev, curr, roomStatus: row.room_status, rate: row.water_rate }), [kind, prev, curr, row])
  const rate = kind === 'elec' ? row.elec_rate : row.water_rate
  const unit = kind === 'elec' ? 'หน่วย' : 'หน่วย (ลบ.ม.)'

  async function onPhoto(file: File | undefined) {
    if (!file) return
    const k = kind
    patch(k, { preview: URL.createObjectURL(file), ai: null, reading: true })
    try {
      const blob = await compressPhoto(file).catch(() => file)
      const path = `meters/${roundId}/${row.code.replace(/[^\w-]/g, '_') || 'room'}-${k}-${crypto.randomUUID()}.jpg`
      await uploadBlobAt(blob, path)
      patch(k, { photo: path })
      try {
        const ai = await edge<AiResult>('read-meter', {
          photo_path: path, room_code: row.code, kind: k, prev: k === 'elec' ? row.elec_prev : row.water_prev,
          prev_units: k === 'elec' ? row.prev_units : null,
        })
        setState((o) => ({ ...o, [k]: { ...o[k], ai, reading: false, text: ai.reading != null && !o[k].text ? String(ai.reading) : o[k].text } }))
      } catch (e) {
        patch(k, { reading: false, ai: { reading: null, digits_seen: '', room_label_seen: null, confidence: 'low', problem: (e as Error).message, warnings: [(e as Error).message] } })
      }
    } catch (e) {
      patch(k, { reading: false })
      toast((e as Error).message, true)
    }
  }

  async function save(goNext: boolean) {
    const r = await run(() => rpc<{ total: number; elec_amount: number; water_amount: number; flags: string[] }>('record_meter', {
      p_round: roundId, p_room: row.room_id, p_kind: kind, p_curr: curr,
      p_photo_path: s.photo, p_ai_value: s.ai?.reading ?? null, p_prev: storedPrev == null ? prev : null,
    }), (x) => `บันทึก ${row.code} แล้ว · ค่า${kind === 'elec' ? 'ไฟ' : 'น้ำ'} ${fmt(kind === 'elec' ? x.elec_amount : x.water_amount)} · รวมบิล ${fmt(x.total)}`
              + (x.flags.length ? ` · ${x.flags.map(flagTh).join(', ')}` : ''))
    if (!r) return
    if (kind === 'elec' && hasWaterMeter && row.water_curr == null) { setKind('water'); return }  // same room: water next
    goNext ? onNext() : onClose()
  }

  const aiDiffers = s.ai?.reading != null && curr != null && curr !== s.ai.reading
  return (
    <Modal title={`จดมิเตอร์ห้อง ${row.code}`} onClose={onClose}>
      <p className="muted mt-0">{STATUS_TH[row.room_status]}{row.tenant_name ? ` · ${row.tenant_name}` : ''}</p>
      {hasWaterMeter && (
        <div className="row mt-0 mb-2">
          {(['elec', 'water'] as const).map((k) => (
            <button key={k} className={`btn sm ${kind === k ? '' : 'ghost'}`} onClick={() => setKind(k)}>
              {k === 'elec' ? 'ไฟฟ้า' : 'น้ำ'}{(k === 'elec' ? row.elec_curr : row.water_curr) != null ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="note">
        เลขครั้งก่อน: {storedPrev != null ? <b>{fmt(storedPrev)}</b>
          : <input className="inp w-28" inputMode="numeric" placeholder="ไม่มีข้อมูล — ใส่เอง" value={s.prevText}
                   onChange={(e) => patch(kind, { prevText: e.target.value })} />}
        {kind === 'elec' && row.prev_units != null && <span className="muted"> · เดือนก่อนใช้ {fmt(row.prev_units)} หน่วย</span>}
      </div>

      <div className="row">
        <label className={`btn ${s.reading ? 'opacity-40 pointer-events-none' : ''}`}>
          {s.reading ? 'กำลังอ่านเลข…' : s.preview ? 'ถ่ายใหม่' : `📷 ถ่ายรูป${kind === 'elec' ? 'มิเตอร์ไฟ' : 'มิเตอร์น้ำ'}`}
          <input type="file" accept="image/*" capture="environment" hidden
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onPhoto(f) }} />
        </label>
        {s.preview && <img src={s.preview} alt="รูปมิเตอร์" className="w-[96px] h-[96px] object-cover rounded-md border" style={{ borderColor: 'var(--line)' }} />}
        {!s.preview && (kind === 'elec' ? row.photo_path : row.water_photo_path) && <Thumbs paths={[(kind === 'elec' ? row.photo_path : row.water_photo_path)!]} label="รูปที่บันทึกไว้" />}
      </div>
      <p className="muted">ให้เห็นตัวเลขชัด ๆ และสติกเกอร์เลขห้องในรูปเดียวกัน</p>

      {s.ai && (
        <div className="al mid">
          {s.ai.reading != null
            ? <>AI อ่านได้ <b>{fmt(s.ai.reading)}</b> <span className="muted">(เห็น "{s.ai.digits_seen}" · มั่นใจ{s.ai.confidence === 'high' ? 'มาก' : s.ai.confidence === 'medium' ? 'ปานกลาง' : 'น้อย'})</span></>
            : <span className="flag">AI อ่านไม่ได้</span>}
          {s.ai.warnings.map((w) => <div key={w} className="flag">{w}</div>)}
          <div className="muted">ตรวจเลขกับรูปทุกครั้งก่อนบันทึก</div>
        </div>
      )}

      <label className="block mt-2">
        <span className="muted">เลขครั้งนี้</span>
        <input className="inp w-full text-2xl" inputMode="numeric" autoComplete="off" placeholder="เช่น 1180"
               value={s.text} onChange={(e) => patch(kind, { text: e.target.value })} />
      </label>
      {s.text && curr == null && <div className="flag">ใส่ตัวเลขเท่านั้น</div>}
      {aiDiffers && <div className="muted">เลขที่พิมพ์ต่างจาก AI ({fmt(s.ai!.reading)}) — ระบบเก็บไว้ทั้งสองค่า</div>}

      {curr != null && prev != null && (
        <div className="bill">
          {kind === 'water' && !hasWaterMeter
            ? <>น้ำเหมา {fmt(row.water_flat)}</>
            : <>ค่า{kind === 'elec' ? 'ไฟ' : 'น้ำ'} {fmt(prev)} → {fmt(curr)} = {fmt(pv.units)} {unit} × {fmt(rate)} = <b>{fmt(pv.amount)}</b> บาท</>}
          {pv.flags.filter((f) => f !== 'missing_elec' && f !== 'missing_water').map((f) => <div key={f} className="flag">⚠ {flagTh(f)}</div>)}
          {(row.room_status === 'vacant' || row.room_status === 'renovation') && <div className="muted">ห้องว่าง — ไม่คิดเงิน แต่บันทึกเลขไว้</div>}
        </div>
      )}

      <div className="row">
        <button className="btn" disabled={busy || s.reading || curr == null || prev == null} onClick={() => save(true)}>บันทึก → ห้องถัดไป</button>
        <button className="btn ghost" disabled={busy || s.reading || curr == null || prev == null} onClick={() => save(false)}>บันทึก</button>
      </div>
      {!s.photo && curr != null && <p className="muted">ยังไม่มีรูปมิเตอร์ — บันทึกได้ แต่ควรถ่ายรูปไว้เป็นหลักฐาน</p>}
    </Modal>
  )
}
