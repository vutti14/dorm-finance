// Bill math (SPEC §4.6). Used for the validation report shown BEFORE import. The server (import_round) recomputes
// everything with the same rules and is the source of truth; tests/db checks both agree on the sample workbook.
import { round2 } from './format'
import { thaiIdOk } from './thaiId'
import type { BuildingId, RoomStatus, RoundPayload } from './importer'

export type MeterFlag =
  | 'missing_elec' | 'missing_water' | 'elec_decreased' | 'water_decreased'
  | 'occupied_zero_use' | 'over_2x_last_month' | 'vacant_has_use'

export const FLAG_TH: Record<MeterFlag, string> = {
  missing_elec: 'ยังไม่จดไฟ',
  missing_water: 'ยังไม่จดน้ำ',
  elec_decreased: 'เลขไฟลดลง',
  water_decreased: 'เลขน้ำลดลง',
  occupied_zero_use: 'มีผู้เช่าแต่ไม่ใช้ไฟ',
  over_2x_last_month: 'ใช้ไฟเกิน 2 เท่าของเดือนก่อน',
  vacant_has_use: 'ห้องว่างแต่มีการใช้ไฟ/น้ำ',
}

export type BillStatus = 'open' | 'closed' | 'vacant' | 'welfare'

export interface PreviewBill {
  code: string
  building: BuildingId
  roomStatus: RoomStatus
  status: BillStatus
  tenant: string | null
  rent: number
  elec: { prev: number | null; curr: number | null; units: number | null; rate: number; amount: number }
  water: { prev: number | null; curr: number | null; units: number | null; rate: number; amount: number; flat: boolean }
  service: number
  discount: number
  items: { description: string; amount: number }[]
  itemsTotal: number
  carryIn: number
  flags: MeterFlag[]
  total: number
}

export interface Warning { sheet: string; room: string; message: string; amount?: number }

export interface RoundPreview {
  bills: PreviewBill[]
  blocking: string[]
  warnings: Warning[]
  totals: {
    N: number; P: number; all: number
    rent: number; elec: number; water: number; service: number; discount: number; items: number; carry: number
  }
}

export interface RateDefaults { elec: number; water: number }

export const hasMeter = (code: string) => !/(จอดรถ|โกดัง)/.test(code)

/** a room code that differs only by a suffix like " (ออฟฟิตเก่า)" — used to suggest a fix, never to auto-match */
function nearMatch(code: string, known: string[]): string | null {
  const base = code.replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, '').toUpperCase()
  return known.find((k) => k.replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, '').toUpperCase() === base) ?? null
}

export function computeRound(p: RoundPayload, defaults: RateDefaults = { elec: 8, water: 30 }): RoundPreview {
  const elecRate = p.settings.elec_rate ?? defaults.elec
  const waterRate = p.settings.water_rate ?? defaults.water
  const meters = new Map(p.meters.map((m) => [m.code, m]))
  const codes = p.rooms.map((r) => r.code)
  const known = new Set(codes)
  const warnings: Warning[] = []
  const unknown = (sheet: string, room: string, what: string, amount?: number) => {
    const near = nearMatch(room, codes)
    warnings.push({
      sheet, room, amount,
      message: `ไม่พบห้องนี้ในแท็บห้องและผู้เช่า — ${what}${near ? ` (หมายถึงห้อง "${near}" หรือไม่? แก้ชื่อในไฟล์ให้ตรง)` : ''}`,
    })
  }

  const items = new Map<string, { description: string; amount: number }[]>()
  for (const it of p.items) {
    if (!known.has(it.code)) { unknown('รายการเพิ่มรอบนี้', it.code, 'ไม่ได้นำเข้า', it.amount); continue }
    items.set(it.code, [...(items.get(it.code) || []), { description: it.description, amount: it.amount }])
  }
  const carry = new Map<string, number>()
  for (const c of p.carry) {
    if (!known.has(c.code)) { unknown('ยอดค้างยกมา', c.code, 'ยอดค้างไม่ได้นำเข้า', c.amount); continue }
    carry.set(c.code, round2((carry.get(c.code) || 0) + c.amount))
  }
  for (const m of p.meters) if (!known.has(m.code)) unknown('จดมิเตอร์', m.code, 'ไม่ได้นำเข้า')
  for (const w of p.workers) {
    if (w.national_id && !thaiIdOk(w.national_id)) {
      warnings.push({ sheet: 'ช่างและแม่บ้าน', room: w.full_name, message: 'เลขบัตรประชาชนไม่ถูกต้อง — จะไม่บันทึกเลขบัตร' })
    }
  }

  const blocking: string[] = []
  const bills: PreviewBill[] = p.rooms.map((r) => {
    const m = meters.get(r.code)
    const billable = r.status === 'occupied' || r.status === 'staff'
    const ep = m?.elec_prev ?? null, ec = m?.elec_curr ?? null
    const wp = m?.water_prev ?? null, wc = m?.water_curr ?? null
    const pu = m?.prev_units ?? null
    const eu = ep != null && ec != null ? round2(ec - ep) : null
    const wu = wp != null && wc != null ? round2(wc - wp) : null
    const eRate = r.elec_rate_override ?? elecRate
    const wFlat = r.water_flat

    const flags: MeterFlag[] = []
    if (hasMeter(r.code)) {
      if (billable && eu == null) flags.push('missing_elec')
      if (billable && wFlat == null && wu == null) flags.push('missing_water')
      if (eu != null && eu < 0) flags.push('elec_decreased')
      if (wu != null && wu < 0) flags.push('water_decreased')
      if (billable && eu === 0) flags.push('occupied_zero_use')
      if (eu != null && pu != null && pu > 0 && eu > 2 * pu) flags.push('over_2x_last_month')
      if (!billable && ((eu ?? 0) > 0 || (wu ?? 0) > 0)) flags.push('vacant_has_use')
    }
    if (r.status === 'occupied' && flags.includes('missing_elec')) blocking.push(r.code)

    const rent = billable ? r.base_rent ?? 0 : 0
    const elecAmount = billable && eu != null && eu > 0 ? round2(eu * eRate) : 0
    const waterAmount = !billable ? 0 : wFlat != null ? wFlat : wu != null && wu > 0 ? round2(wu * waterRate) : 0
    const service = billable ? r.service_fee ?? 0 : 0
    const discount = billable ? r.recurring_discount ?? 0 : 0
    const its = items.get(r.code) || []
    const itemsTotal = round2(its.reduce((s, i) => s + i.amount, 0))
    const carryIn = carry.get(r.code) || 0
    const total = round2(rent + elecAmount + waterAmount + service - discount + itemsTotal + carryIn)
    let status: BillStatus = r.status === 'staff' ? 'welfare' : r.status === 'occupied' ? 'open' : 'vacant'
    if (status === 'vacant' && total !== 0) status = 'open'

    return {
      code: r.code, building: r.building, roomStatus: r.status, status, tenant: r.tenant_name,
      rent,
      elec: { prev: ep, curr: ec, units: eu, rate: eRate, amount: elecAmount },
      water: { prev: wp, curr: wc, units: wu, rate: waterRate, amount: waterAmount, flat: billable && wFlat != null },
      service, discount, items: its, itemsTotal, carryIn, flags, total,
    }
  })

  const sum = (f: (b: PreviewBill) => number, keep: (b: PreviewBill) => boolean = () => true) =>
    round2(bills.filter(keep).reduce((s, b) => s + f(b), 0))
  const billed = (b: PreviewBill) => b.status !== 'vacant'
  return {
    bills,
    blocking,
    warnings,
    totals: {
      N: sum((b) => b.total, (b) => billed(b) && b.building === 'N'),
      P: sum((b) => b.total, (b) => billed(b) && b.building === 'P'),
      all: sum((b) => b.total, billed),
      rent: sum((b) => b.rent),
      elec: sum((b) => b.elec.amount),
      water: sum((b) => b.water.amount),
      service: sum((b) => b.service),
      discount: sum((b) => b.discount),
      items: sum((b) => b.itemsTotal),
      carry: sum((b) => b.carryIn),
    },
  }
}
