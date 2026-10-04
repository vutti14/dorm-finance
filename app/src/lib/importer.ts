// Excel round import (SPEC §8.1). Reads only the input columns of the team's template — never the formula
// columns (หน่วยไฟ, ค่าไฟ, สรุปบิล…). Output is the JSON payload for the import_round RPC.
import * as XLSX from 'xlsx'

export type RoomStatus = 'occupied' | 'vacant' | 'staff' | 'renovation'
export type BuildingId = 'N' | 'P'

export interface RoundSettings {
  label: string
  meter_month: string | null
  issue_date: string | null
  due_date: string | null
  elec_rate: number | null
  water_rate: number | null
  pen_day: number | null
  pen_max: number | null
  bill_name: Partial<Record<BuildingId, string>>
  bank: Partial<Record<BuildingId, { bank: string; name: string; no: string }>>
  contact: string | null
}
export interface RoomRow {
  building: BuildingId
  code: string
  status: RoomStatus
  base_rent: number | null
  tenant_name: string | null
  tenant_phone: string | null
  move_in: string | null
  deposit_held: number | null
  elec_rate_override: number | null
  water_flat: number | null
  service_fee: number | null
  recurring_discount: number | null
  note: string | null
}
export interface MeterRow {
  code: string
  elec_prev: number | null
  elec_curr: number | null
  water_prev: number | null
  water_curr: number | null
  prev_units: number | null
  read_by: string | null
  note: string | null
}
export interface ItemRow { code: string; description: string; amount: number; note: string | null }
export interface CarryRow { code: string; amount: number; note: string | null }
export interface WorkerRow {
  full_name: string
  kind: 'technician' | 'maid'
  daily_rate: number | null
  phone: string | null
  national_id: string | null
  note: string | null
}
export interface RoundPayload {
  settings: RoundSettings
  rooms: RoomRow[]
  meters: MeterRow[]
  items: ItemRow[]
  carry: CarryRow[]
  workers: WorkerRow[]
}
export interface ParseResult { payload: RoundPayload | null; errors: string[] }

const REQUIRED_SHEETS = ['ตั้งค่า', 'ห้องและผู้เช่า', 'จดมิเตอร์']
const STATUS: Record<string, RoomStatus> = {
  'มีผู้เช่า': 'occupied', 'ว่าง': 'vacant', 'ห้องพนักงาน': 'staff', 'ปิดปรับปรุง': 'renovation',
}
type Cell = string | number | boolean | Date | null | undefined

const pad = (n: number) => String(n).padStart(2, '0')

/** Excel serial, Date, "dd/mm/yyyy" (Buddhist year > 2400 → −543) or ISO → "YYYY-MM-DD" */
export function xDate(v: Cell): string | null {
  if (v === '' || v == null) return null
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 864e5))
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    let y = Number(m[3])
    if (y > 2400) y -= 543
    return `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    let y = Number(iso[1])
    if (y > 2400) y -= 543
    return `${y}-${iso[2]}-${iso[3]}`
  }
  return null
}

export function xNum(v: Cell): number | null {
  if (v === '' || v == null || typeof v === 'boolean' || v instanceof Date) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

export function xText(v: Cell): string | null {
  if (v == null || v instanceof Date) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const digits = (v: Cell) => (xText(v) || '').replace(/\D/g, '') || null

function rowsOf(wb: XLSX.WorkBook, name: string): Cell[][] | null {
  const ws = wb.Sheets[name]
  if (!ws) return null
  return XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: '' })
}

function table(wb: XLSX.WorkBook, name: string): Record<string, Cell>[] {
  const rows = rowsOf(wb, name) || []
  const head = (rows[0] || []).map((h) => String(h ?? '').trim())
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])))
}

export function parseWorkbook(data: ArrayBuffer | Uint8Array): ParseResult {
  const errors: string[] = []
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(data, { type: 'array', cellFormula: false, cellDates: false })
  } catch {
    return { payload: null, errors: ['เปิดไฟล์ไม่ได้ — ต้องเป็นไฟล์ .xlsx จากแบบฟอร์มของระบบ'] }
  }
  for (const n of REQUIRED_SHEETS) if (!wb.Sheets[n]) errors.push(`ไม่พบแท็บ "${n}" — ใช้แบบฟอร์มของระบบเท่านั้น ห้ามเปลี่ยนชื่อแท็บ`)
  if (errors.length) return { payload: null, errors }

  // ---- ตั้งค่า (col A label / col B value)
  const set: Record<string, Cell> = {}
  for (const r of (rowsOf(wb, 'ตั้งค่า') || []).slice(1)) {
    const k = xText(r[0])
    if (k) set[k] = r[1]
  }
  const bank = (k: string) => ({
    bank: xText(set[`บัญชีรับโอน ${k} - ธนาคาร`]) || '',
    name: xText(set[`บัญชีรับโอน ${k} - ชื่อบัญชี`]) || '',
    no: xText(set[`บัญชีรับโอน ${k} - เลขบัญชี`]) || '',
  })
  const settings: RoundSettings = {
    label: xText(set['รอบบิล']) || '',
    meter_month: xText(set['เดือนที่จดมิเตอร์']),
    issue_date: xDate(set['วันที่ออกบิล']),
    due_date: xDate(set['วันครบกำหนดชำระ']),
    elec_rate: xNum(set['ค่าไฟต่อหน่วย (บาท)']),
    water_rate: xNum(set['ค่าน้ำต่อหน่วย (บาท)']),
    pen_day: xNum(set['ค่าปรับต่อวัน (บาท)']),
    pen_max: xNum(set['ค่าปรับสูงสุด (บาท)']),
    bill_name: {
      N: xText(set['ชื่อบนบิล นารา']) || undefined,
      P: xText(set['ชื่อบนบิล ปรายดาว']) || undefined,
    },
    bank: { N: bank('นารา'), P: bank('ปรายดาว') },
    contact: xText(set['เบอร์ติดต่อบนบิล']),
  }
  if (!settings.label) errors.push('แท็บ "ตั้งค่า": ไม่มีชื่อรอบบิล')
  if (!settings.due_date) errors.push('แท็บ "ตั้งค่า": วันครบกำหนดชำระว่างหรืออ่านไม่ได้ (ใช้ วว/ดด/ปปปป)')

  // ---- ห้องและผู้เช่า
  const rooms: RoomRow[] = []
  const seen = new Set<string>()
  for (const r of table(wb, 'ห้องและผู้เช่า')) {
    const code = xText(r['ห้อง'])
    if (!code) continue
    const bText = xText(r['อาคาร']) || ''
    const building: BuildingId | null = /ปราย/.test(bText) ? 'P' : /นารา/.test(bText) ? 'N' : null
    const status = STATUS[xText(r['สถานะ']) || '']
    if (!building) errors.push(`ห้อง ${code}: อาคารต้องเป็น "นารา" หรือ "ปรายดาว"`)
    if (!status) errors.push(`ห้อง ${code}: สถานะต้องเป็น มีผู้เช่า / ว่าง / ห้องพนักงาน / ปิดปรับปรุง`)
    if (seen.has(code)) errors.push(`ห้อง ${code} ซ้ำในแท็บ "ห้องและผู้เช่า"`)
    seen.add(code)
    rooms.push({
      building: building || 'N',
      code,
      status: status || 'vacant',
      base_rent: xNum(r['ค่าเช่า/เดือน']),
      tenant_name: xText(r['ชื่อผู้เช่า']),
      tenant_phone: digits(r['เบอร์โทร']),
      move_in: xDate(r['วันเข้าพัก']),
      deposit_held: xNum(r['เงินประกันที่ถืออยู่']),
      elec_rate_override: xNum(r['ค่าไฟพิเศษ/หน่วย']),
      water_flat: xNum(r['ค่าน้ำเหมา/เดือน']),
      service_fee: xNum(r['ค่าบริการประจำ/เดือน']),
      recurring_discount: xNum(r['ส่วนลดประจำ/เดือน']),
      note: xText(r['หมายเหตุ']),
    })
  }
  if (!rooms.length) errors.push('ไม่พบห้องในแท็บ "ห้องและผู้เช่า"')

  // ---- จดมิเตอร์ (skip summary rows)
  const meters: MeterRow[] = []
  for (const r of table(wb, 'จดมิเตอร์')) {
    const code = xText(r['ห้อง'])
    if (!code || /^รวม|^ห้องที่ต้องตรวจ/.test(code)) continue
    meters.push({
      code,
      elec_prev: xNum(r['ไฟ เลขครั้งก่อน']),
      elec_curr: xNum(r['ไฟ เลขครั้งนี้']),
      water_prev: xNum(r['น้ำ เลขครั้งก่อน']),
      water_curr: xNum(r['น้ำ เลขครั้งนี้']),
      prev_units: xNum(r['หน่วยไฟเดือนก่อน']),
      read_by: xText(r['ผู้จด']),
      note: xText(r['หมายเหตุ']),
    })
  }

  // ---- รายการเพิ่มรอบนี้
  const items: ItemRow[] = []
  for (const r of table(wb, 'รายการเพิ่มรอบนี้')) {
    const code = xText(r['ห้อง'])
    const amount = xNum(r['จำนวนเงิน'])
    if (!code || !amount) continue
    items.push({ code, description: xText(r['รายการ']) || 'รายการเพิ่ม', amount, note: xText(r['หมายเหตุ']) })
  }

  // ---- ยอดค้างยกมา
  const carry: CarryRow[] = []
  for (const r of table(wb, 'ยอดค้างยกมา')) {
    const code = xText(r['ห้อง'])
    const amount = xNum(r['ยอดค้าง (บาท)'])
    if (!code || !amount) continue
    carry.push({ code, amount, note: [xText(r['ค้างของรอบไหน']), xText(r['หมายเหตุ'])].filter(Boolean).join(' · ') || null })
  }

  // ---- ช่างและแม่บ้าน
  const workers: WorkerRow[] = []
  for (const r of table(wb, 'ช่างและแม่บ้าน')) {
    const full_name = xText(r['ชื่อ-นามสกุล'])
    if (!full_name) continue
    workers.push({
      full_name,
      kind: /แม่บ้าน/.test(xText(r['ประเภท']) || '') ? 'maid' : 'technician',
      daily_rate: xNum(r['ค่าแรง/วัน']),
      phone: digits(r['เบอร์โทร']),
      national_id: digits(r['เลขบัตรประชาชน']),
      note: xText(r['หมายเหตุ']),
    })
  }

  return { payload: errors.length ? null : { settings, rooms, meters, items, carry, workers }, errors }
}
