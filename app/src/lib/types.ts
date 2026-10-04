import type { BuildingId } from './importer'

export type Role = 'ceo' | 'manager' | 'finance_field' | 'finance' | 'auditor' | 'worker'

export const ROLE_TH: Record<Role, string> = {
  ceo: 'CEO · ทำได้ทุกอย่าง',
  manager: 'ผู้จัดการ · ขอเบิก/วางบิล',
  finance_field: 'การเงินหน้างาน · จ่าย/วางบิล',
  finance: 'บัญชี · รับเงิน/อนุมัติ/ตรวจ',
  auditor: 'ตรวจสอบ · แจ้งเตือน',
  worker: 'ช่าง/แม่บ้าน',
}

export interface Profile {
  id: string
  display_name: string
  phone: string
  role: Role
  worker_id: string | null
  active: boolean
  consent_at: string | null
}

export interface Round {
  id: string
  label: string
  meter_month: string | null
  issue_date: string | null
  due_date: string
  status: 'draft' | 'issued' | 'closed'
  rates: { elec: number; water: number; pen_day: number; pen_max: number }
  bill_info: {
    names?: Partial<Record<BuildingId, string | null>>
    bank?: Partial<Record<BuildingId, { bank: string | null; name: string | null; no: string | null }>>
    contact?: string | null
  }
}

export interface BillRow {
  id: string
  round_id: string
  room_id: string
  tenant_name: string | null
  tenant_phone: string | null
  status: 'open' | 'closed' | 'vacant' | 'welfare' | 'carried'
  rent: number
  elec_prev: number | null; elec_curr: number | null; elec_units: number | null; elec_rate: number | null; elec_amount: number
  water_prev: number | null; water_curr: number | null; water_units: number | null; water_rate: number | null; water_amount: number
  water_is_flat: boolean
  service: number; discount: number; penalty: number; carry_in: number; items_total: number; paid: number; total: number
  carry_note?: string | null
  flags: string[]
  rooms: { code: string; building_id: BuildingId; status: string; base_rent: number }
  bill_items: { description: string; amount: number; source: string; reason: string | null }[]
}

export interface Alert { level: 'high' | 'mid'; kind: string; title: string; detail: string | null; amount: number | null }

/** numeric columns arrive as strings from PostgREST — normalise */
export function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
export function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
