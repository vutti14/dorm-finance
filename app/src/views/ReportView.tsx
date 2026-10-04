// M5 รายงาน (inside ภาพรวม): monthly NOI per building split rent / electricity margin / water margin — same method as
// reference/NOI-dashboard.html — plus Excel export of NOI, ledger and bills. Numbers come from noi_monthly() on the server.
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt as fmt2, round2, todayTH } from '../lib/format'
import { num } from '../lib/types'
import { Loading, Stat, useAction } from '../components/ui'

export interface NoiRow {
  month: string; building_id: 'N' | 'P'; source: 'history' | 'ledger'
  revenue: number; other_income: number | null; other_expense: number | null; elec_billed: number | null; water_billed: number | null; elec_cost: number | null; water_cost: number | null
  op_cost: number | null; rent_profit: number; elec_margin: number; water_margin: number; noi: number; capex: number; deposits_net: number
}
type View = 'all' | 'N' | 'P'

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
export const monthTh = (m: string) => `${TH_MONTH[Number(m.slice(5, 7)) - 1]} ${String(Number(m.slice(0, 4)) + 543).slice(2)}`
const BLD = { N: 'นารา', P: 'ปรายดาว' } as const
// whole baht on screen, like the owner's dashboard (the Excel export keeps satang)
const fmt = (n: number | null | undefined) => fmt2(Math.round(Number(n) || 0))
const CAT_TH: Record<string, string> = {
  rent_receipt: 'รับค่าห้อง', labor: 'ค่าแรง', material: 'ค่าวัสดุ', common: 'ส่วนกลาง', salary: 'เงินเดือน', transfer: 'โอนระหว่างบัญชี',
  owner_draw: 'โอนให้เจ้าของ', owner_injection: 'เจ้าของเติมเงิน', owner_paid_expense: 'เจ้าของจ่ายแทน (ค่าไฟ กฟภ.)',
  deposit: 'รับเงินประกัน', deposit_refund: 'คืนเงินประกัน', petty_refill: 'เติมเงินสำรอง', staff_room: 'ค่าห้องพนักงาน (ไม่ใช่เงินสด)',
  welfare_housing: 'สวัสดิการที่พัก (ไม่ใช่เงินสด)', opening_balance: 'ยอดยกมา', adjustment: 'ปรับปรุง',
  water_utility: 'บิลค่าน้ำประปา', elec_utility: 'บิลค่าไฟ กฟภ.', other_income: 'รายได้อื่น', other_expense: 'รายจ่ายอื่น',
}

/** pure: sum NOI rows per month for a building or both */
export function rollup(rows: NoiRow[], view: View) {
  const months = [...new Set(rows.map((r) => r.month))].sort()
  const pick = (m: string) => rows.filter((r) => r.month === m && (view === 'all' || r.building_id === view))
  const s = (list: NoiRow[], k: keyof NoiRow) => round2(list.reduce((a, r) => a + num(r[k]), 0))
  const byMonth = months.map((m) => {
    const list = pick(m)
    return { month: m, source: list.some((r) => r.source === 'history') ? 'history' : 'ledger',
             revenue: round2(s(list, 'revenue') + s(list, 'other_income')), rent: s(list, 'rent_profit'), elec: s(list, 'elec_margin'), water: s(list, 'water_margin'),
             noi: s(list, 'noi'), capex: s(list, 'capex'), deposits: s(list, 'deposits_net') }
  })
  const tot = (k: 'revenue' | 'rent' | 'elec' | 'water' | 'noi' | 'capex') => round2(byMonth.reduce((a, r) => a + r[k], 0))
  return { byMonth, total: { revenue: tot('revenue'), rent: tot('rent'), elec: tot('elec'), water: tot('water'), noi: tot('noi'), capex: tot('capex') } }
}

export default function NoiReport() {
  const now = todayTH()
  const [year, setYear] = useState(Number(now.slice(0, 4)))
  const [view, setView] = useState<View>('all')
  const { busy, run } = useAction()
  const to = year < Number(now.slice(0, 4)) ? `${year}-12` : now.slice(0, 7)
  const from = `${year}-01`

  const data = useLive<NoiRow[]>(async () => {
    const { data, error } = await supabase.rpc('noi_monthly', { p_from: from, p_to: to })
    if (error) throw error
    return data as NoiRow[]
  }, ['ledger_entries', 'bills', 'bill_rounds'], [from, to])

  if (!data.data) return <Loading error={data.error} />
  const rows = data.data.filter((r) => r.source === 'history' || num(r.revenue) || num(r.other_income) || num(r.other_expense) || num(r.op_cost) || num(r.elec_cost) || num(r.water_cost) || num(r.elec_billed))
  const { byMonth, total } = rollup(rows, view)
  const n = byMonth.length || 1
  const hist = byMonth.filter((m) => m.source === 'history')
  const both = rollup(rows, 'N').byMonth.map((r, i) => ({ N: r, P: rollup(rows, 'P').byMonth[i] }))

  return (
    <div className="panel">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h2 className="m-0">กำไรจริงจากการดำเนินงาน (NOI) · ปี {year + 543}</h2>
        <div className="row mt-0">
          <select className="inp" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="ปี">
            {[2026, 2027, 2028].filter((y) => y <= Number(now.slice(0, 4))).map((y) => <option key={y} value={y}>{y + 543}</option>)}
          </select>
          {(['all', 'N', 'P'] as const).map((v) => (
            <button key={v} className={`btn sm ${view === v ? '' : 'ghost'}`} onClick={() => setView(v)}>{v === 'all' ? 'รวม' : BLD[v]}</button>
          ))}
          <button className="btn sm ghost" disabled={busy} onClick={() => run(() => exportWorkbook(from, to, data.data!), 'ดาวน์โหลดไฟล์ Excel แล้ว')}>ส่งออก Excel</button>
        </div>
      </div>

      <div className="grid-stats mt-3">
        <Stat value={fmt(total.noi)} label={`NOI ${byMonth.length} เดือน · ${fmt(total.noi / n)}/เดือน`} tone="ok" />
        <Stat value={total.revenue ? `${Math.round((total.noi / total.revenue) * 100)}%` : '—'} label={`อัตรากำไร · รายได้ ${fmt(total.revenue / n)}/เดือน`} />
        <Stat value={fmt(total.elec)} label={`กำไรค่าไฟ (เก็บ − กฟภ.) · ${fmt(total.elec / n)}/เดือน`} />
        <Stat value={fmt(total.water)} label={`กำไรค่าน้ำ (เก็บ − ประปา) · ${fmt(total.water / n)}/เดือน`} />
      </div>

      <div className="scroll mt-3">
        {view === 'all' ? (
          <table className="t">
            <thead>
              <tr><th rowSpan={2}>เดือน</th><th colSpan={4} className="text-center">นารา</th><th colSpan={4} className="text-center">ปรายดาว</th><th rowSpan={2} className="n">รวม NOI</th></tr>
              <tr>{[0, 1].map((k) => ['ค่าห้อง', 'ไฟ', 'น้ำ', 'NOI'].map((h) => <th key={k + h} className="n">{h}</th>))}</tr>
            </thead>
            <tbody>
              {both.map(({ N, P }) => (
                <tr key={N.month}>
                  <td className="whitespace-nowrap">{monthTh(N.month)}{N.source === 'history' && <span className="muted"> *</span>}</td>
                  {[N, P].map((x, k) => (
                    <Cells key={k} vals={[x.rent, x.elec, x.water]} noi={x.noi} />
                  ))}
                  <td className="n"><b>{fmt(N.noi + P.noi)}</b></td>
                </tr>
              ))}
              <tr className="font-semibold"><td>รวม</td>
                {(['N', 'P'] as const).map((b) => { const t = rollup(rows, b).total; return <Cells key={b} vals={[t.rent, t.elec, t.water]} noi={t.noi} /> })}
                <td className="n"><b>{fmt(total.noi)}</b></td></tr>
            </tbody>
          </table>
        ) : (
          <Detail rows={rows.filter((r) => r.building_id === view)} />
        )}
      </div>
      <p className="muted">
        เกณฑ์เงินสด เหมือนแดชบอร์ด NOI เดิม: รายได้ = เงินค่าห้องที่รับจริง (รวมยอดค้าง/ค่าปรับ) + รายได้อื่น · กำไรค่าไฟ = ค่าไฟที่เรียกเก็บในบิล − บิล กฟภ. (รวมที่เจ้าของจ่ายแทน) ·
        กำไรค่าน้ำ = ค่าน้ำที่เรียกเก็บ − บิลประปา · ค่าใช้จ่ายร่วม (เงินเดือน ส่วนกลาง) แบ่งตามจำนวนห้อง (ตั้งค่าได้) · งบลงทุน เงินประกัน และค่าใช้จ่ายอสังหาฯ ไม่อยู่ใน NOI
        {hist.length > 0 && <> · * {hist.length} เดือนแรกมาจากสมุดบัญชีมือ (แดชบอร์ดเดิม)</>}
      </p>
    </div>
  )
}

function Cells({ vals, noi }: { vals: number[]; noi: number }) {
  return (
    <>
      {vals.map((v, i) => <td key={i} className="n" style={v < 0 ? { color: 'var(--out)' } : undefined}>{fmt(v)}</td>)}
      <td className="n"><b>{fmt(noi)}</b></td>
    </>
  )
}

function Detail({ rows }: { rows: NoiRow[] }) {
  const line = (label: string, f: (r: NoiRow) => number | null, bold = false) => (
    <tr className={bold ? 'font-semibold' : ''}>
      <td>{label}</td>
      {rows.map((r) => { const v = f(r); return <td key={r.month} className="n">{v == null ? <span className="muted">—</span> : fmt(v)}</td> })}
      <td className="n"><b>{fmt(rows.reduce((a, r) => a + num(f(r)), 0))}</b></td>
    </tr>
  )
  return (
    <table className="t">
      <thead><tr><th></th>{rows.map((r) => <th key={r.month} className="n">{monthTh(r.month)}{r.source === 'history' ? ' *' : ''}</th>)}<th className="n">รวม</th></tr></thead>
      <tbody>
        {line('รายได้ค่าห้องที่รับจริง', (r) => num(r.revenue))}
        {line('รายได้อื่น (ซักผ้า ตู้น้ำ ฯลฯ)', (r) => r.other_income)}
        {line('ค่าไฟที่เรียกเก็บ', (r) => r.elec_billed)}
        {line('ค่าน้ำที่เรียกเก็บ', (r) => r.water_billed)}
        {line('บิลค่าไฟ กฟภ.', (r) => r.elec_cost)}
        {line('บิลค่าน้ำประปา', (r) => r.water_cost)}
        {line('ค่าใช้จ่ายดำเนินงาน', (r) => r.op_cost)}
        {line('รายจ่ายอื่น', (r) => r.other_expense)}
        {line('กำไรจากค่าห้อง', (r) => num(r.rent_profit), true)}
        {line('กำไรค่าไฟ', (r) => num(r.elec_margin))}
        {line('กำไรค่าน้ำ', (r) => num(r.water_margin))}
        {line('= NOI', (r) => num(r.noi), true)}
        {line('งบลงทุน (ไม่อยู่ใน NOI)', (r) => num(r.capex))}
        {line('เงินประกันรับสุทธิ (หนี้สิน)', (r) => num(r.deposits_net))}
      </tbody>
    </table>
  )
}

async function exportWorkbook(from: string, to: string, noi: NoiRow[]) {
  const XLSX = await import('xlsx')   // big: load only when exporting
  const end = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 1)).toISOString().slice(0, 10)
  const [{ data: led, error: e1 }, { data: bills, error: e2 }, { data: projects }, { data: wallets }] = await Promise.all([
    supabase.from('ledger_entries').select('on_date, wallet_id, amount, category, project_id, description, created_at')
      .gte('on_date', `${from}-01`).lt('on_date', end).order('on_date').order('id'),
    supabase.from('bills').select('tenant_name, status, rent, elec_prev, elec_curr, elec_units, elec_rate, elec_amount, water_prev, water_curr, water_units, water_amount, service, discount, items_total, penalty, carry_in, total, paid, rooms(code, building_id), bill_rounds!inner(label, issue_date, due_date, status)')
      .neq('bill_rounds.status', 'draft'),
    supabase.from('projects').select('id, name'),
    supabase.from('wallets').select('id, name'),
  ])
  if (e1) throw new Error(e1.message)
  if (e2) throw new Error(e2.message)
  const pName = Object.fromEntries((projects || []).map((p) => [p.id, p.name]))
  const wName = Object.fromEntries((wallets || []).map((w) => [w.id, w.name]))
  const inRange = (d: string | null) => !!d && d.slice(0, 7) >= from && d.slice(0, 7) <= to
  type BillX = Record<string, any> & { rooms: { code: string; building_id: string }; bill_rounds: { label: string; issue_date: string | null; due_date: string; status: string } }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(noi.map((r) => ({
    'เดือน': r.month, 'อาคาร': BLD[r.building_id], 'ที่มา': r.source === 'history' ? 'สมุดมือ' : 'ระบบ',
    'รายได้ค่าห้องที่รับจริง': num(r.revenue), 'รายได้อื่น': r.other_income == null ? '' : num(r.other_income), 'ค่าไฟที่เรียกเก็บ': r.elec_billed == null ? '' : num(r.elec_billed),
    'ค่าน้ำที่เรียกเก็บ': r.water_billed == null ? '' : num(r.water_billed), 'บิล กฟภ.': r.elec_cost == null ? '' : num(r.elec_cost),
    'บิลประปา': r.water_cost == null ? '' : num(r.water_cost), 'ค่าใช้จ่ายดำเนินงาน': r.op_cost == null ? '' : num(r.op_cost), 'รายจ่ายอื่น': r.other_expense == null ? '' : num(r.other_expense),
    'กำไรค่าห้อง': num(r.rent_profit), 'กำไรค่าไฟ': num(r.elec_margin), 'กำไรค่าน้ำ': num(r.water_margin), 'NOI': num(r.noi),
    'งบลงทุน': num(r.capex), 'เงินประกันสุทธิ': num(r.deposits_net),
  }))), 'NOI')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((led || []).map((l) => ({
    'วันที่': l.on_date, 'บัญชี': wName[l.wallet_id] || l.wallet_id, 'เข้า': num(l.amount) > 0 ? num(l.amount) : '',
    'ออก': num(l.amount) < 0 ? -num(l.amount) : '', 'หมวด': CAT_TH[l.category] || l.category,
    'โครงการ': l.project_id ? pName[l.project_id] || l.project_id : '', 'รายการ': l.description || '',
  }))), 'บัญชี')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(((bills || []) as unknown as BillX[])
    .filter((b) => inRange(b.bill_rounds.issue_date || b.bill_rounds.due_date))
    .sort((a, b) => a.bill_rounds.due_date.localeCompare(b.bill_rounds.due_date) || a.rooms.code.localeCompare(b.rooms.code, 'th', { numeric: true }))
    .map((b) => ({
      'รอบบิล': b.bill_rounds.label, 'อาคาร': BLD[b.rooms.building_id as 'N' | 'P'], 'ห้อง': b.rooms.code, 'ผู้เช่า': b.tenant_name || '',
      'สถานะ': ({ open: 'ค้าง', closed: 'ปิดแล้ว', vacant: 'ว่าง', welfare: 'ห้องพนักงาน', carried: 'ยกไปรอบถัดไป' } as Record<string, string>)[b.status] || b.status,
      'ค่าเช่า': num(b.rent), 'ไฟ ครั้งก่อน': b.elec_prev ?? '', 'ไฟ ครั้งนี้': b.elec_curr ?? '', 'หน่วยไฟ': b.elec_units ?? '',
      'ค่าไฟ': num(b.elec_amount), 'น้ำ ครั้งก่อน': b.water_prev ?? '', 'น้ำ ครั้งนี้': b.water_curr ?? '', 'ค่าน้ำ': num(b.water_amount),
      'ค่าบริการ': num(b.service), 'ส่วนลด': num(b.discount), 'รายการเพิ่ม': num(b.items_total), 'ค่าปรับ': num(b.penalty),
      'ค้างยกมา': num(b.carry_in), 'รวม': num(b.total), 'รับแล้ว': num(b.paid), 'คงค้าง': round2(num(b.total) - num(b.paid)),
    }))), 'บิล')
  XLSX.writeFile(wb, `dorm-report_${from}_${to}.xlsx`)
}
