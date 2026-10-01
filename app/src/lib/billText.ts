// LINE message for one bill — same lines and order as prototype billText() (SPEC §4.6)
import { fmt, round2, thaiDate } from './format'
import type { BuildingId } from './importer'

export interface BillView {
  code: string
  building: BuildingId
  status: 'open' | 'closed' | 'vacant' | 'welfare'
  tenant: string | null
  rent: number
  elec: { prev: number | null; curr: number | null; units: number | null; rate: number; amount: number }
  water: { prev: number | null; curr: number | null; units: number | null; rate: number; amount: number; flat: boolean }
  service: number
  discount: number
  items: { description: string; amount: number }[]
  penalty?: number
  carryIn: number
  total: number
}

export interface RoundInfo {
  label: string
  due_date: string
  names: Partial<Record<BuildingId, string | null>>
  bank: Partial<Record<BuildingId, { bank?: string | null; name?: string | null; no?: string | null }>>
  contact: string | null
}

const DEFAULT_NAME: Record<BuildingId, string> = { N: 'นารา แมนชั่น', P: 'ปรายดาวรีสอร์ท' }

export function billText(b: BillView, r: RoundInfo, paid: number): string {
  const L: string[] = []
  L.push(`${r.names[b.building] || DEFAULT_NAME[b.building]} · ห้อง ${b.code}`)
  if (b.tenant) L.push(`คุณ${b.tenant}`)
  L.push(`แจ้งค่าเช่า ${r.label}`, '')
  L.push(`ค่าเช่า ${fmt(b.rent)}`)
  if (b.elec.units != null && b.elec.prev != null && b.elec.curr != null && b.elec.amount)
    L.push(`ค่าไฟ ${fmt(b.elec.prev)} → ${fmt(b.elec.curr)} = ${fmt(b.elec.units)} หน่วย × ${b.elec.rate} = ${fmt(b.elec.amount)}`)
  else if (b.elec.amount) L.push(`ค่าไฟ ${fmt(b.elec.amount)}`)
  if (b.water.flat) L.push(`ค่าน้ำ (เหมา) ${fmt(b.water.amount)}`)
  else if (b.water.units != null && b.water.prev != null && b.water.curr != null && b.water.amount)
    L.push(`ค่าน้ำ ${fmt(b.water.prev)} → ${fmt(b.water.curr)} = ${fmt(b.water.units)} หน่วย × ${b.water.rate} = ${fmt(b.water.amount)}`)
  else if (b.water.amount) L.push(`ค่าน้ำ ${fmt(b.water.amount)}`)
  if (b.service) L.push(`ค่าบริการประจำ ${fmt(b.service)}`)
  for (const i of b.items) L.push(`${i.description} ${fmt(i.amount)}`)
  if (b.discount) L.push(`ส่วนลด -${fmt(b.discount)}`)
  if (b.penalty) L.push(`ค่าปรับชำระล่าช้า ${fmt(b.penalty)}`)
  if (b.carryIn) L.push(`ค้างชำระยกมา ${fmt(b.carryIn)}`)
  L.push('', `รวมทั้งสิ้น ${fmt(b.total)} บาท`)
  if (paid) L.push(`ชำระแล้ว ${fmt(paid)} · คงเหลือ ${fmt(Math.max(0, round2(b.total - paid)))} บาท`)
  if (b.status === 'welfare') {
    L.push('สวัสดิการพนักงาน — หักจากค่าตอบแทน ไม่ต้องโอน')
    return L.join('\n')
  }
  L.push(`กรุณาชำระภายใน ${thaiDate(r.due_date)}`)
  const bk = r.bank[b.building]
  if (bk?.no) L.push(`โอนเข้า ${[bk.bank, bk.name, bk.no].filter(Boolean).join(' ')}`)
  if (r.contact) L.push(`ส่งสลิป/สอบถาม ${r.contact}`)
  return L.join('\n')
}
