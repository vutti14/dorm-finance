// Requests (ใบเบิก) — types, Thai labels, routing preview, live loader (SPEC §4.3)
import { supabase } from './supabase'
import { useLive } from './live'
import { num, type Role } from './types'

export type ReqType = 'daily_labor' | 'material' | 'common' | 'salary' | 'petty_refill'
export type ReqStatus = 'to_approve' | 'to_pay' | 'paid' | 'asked' | 'audited' | 'rejected'

export const TYPE_TH: Record<ReqType, string> = {
  daily_labor: 'งานรายวัน', material: 'วัสดุ/ค่าใช้จ่าย', common: 'ส่วนกลาง', salary: 'เบิกเงินเดือน', petty_refill: 'เติมเงินสำรอง',
}
export const STATUS_TH: Record<ReqStatus, string> = {
  to_approve: 'รออนุมัติ', to_pay: 'รอจ่าย', paid: 'จ่ายแล้ว รอตรวจ', asked: 'มีคำถาม', audited: 'ตรวจแล้ว', rejected: 'ไม่อนุมัติ',
}
export const WORKTYPE_TH: Record<string, string> = { routine: 'ซ่อมประจำ', renovation: 'สร้าง/ปรับปรุงห้อง', project: 'งานโครงการ' }
export const WALLET_TH: Record<string, string> = { N: 'บัญชีนารา', P: 'บัญชีปรายดาว', A3: 'บัญชี3 (กลาง)', PC: 'เงินสำรองนุ้ย', OWNER_PAID: 'เจ้าของจ่ายแทน' }
export const ROLE_PERSON: Record<string, string> = { finance_field: 'นุ้ย', finance: 'กวาง', manager: 'เป้อ', ceo: 'อาร์ต', auditor: 'หน่อย' }
export const FLAG_TH: Record<string, string> = {
  no_payment_proof: 'ไม่มีรูปผู้รับเงิน/สลิป',
  no_work_photo: 'ไม่มีรูปงาน',
  common_not_itemised: 'ค่าใช้จ่ายส่วนกลางไม่แยกรายการ',
  real_estate_loan: 'มีค่าใช้จ่ายอสังหาฯ/ส่วนตัว → ลงบัญชีหอให้ยืมเจ้าของ',
  renovation_no_room: 'งานปรับปรุงไม่ระบุห้อง',
  no_checkin: 'คนงานไม่ได้ลงเวลางานวันนั้น',
  checkin_far: 'ลงเวลางานไม่มีพิกัดหรือห่างหอเกิน 300 ม.',
}

/** same rule as route_request() on the server — only for showing who will approve/pay before sending */
export function routeFor(type: ReqType, total: number) {
  if (type === 'salary' || type === 'petty_refill' || total > 10000) return { approver: 'finance', payer: 'finance', wallet: 'A3', status: 'to_approve' as const }
  if (total > 3000) return { approver: 'finance', payer: 'finance_field', wallet: 'PC', status: 'to_approve' as const }
  return { approver: 'finance_field', payer: 'finance_field', wallet: 'PC', status: 'to_pay' as const }
}

export interface ReqLine {
  id: string; request_id: string; worker_id: string | null; description: string; amount: number
  project_id: string; work_type: string | null; room_code: string | null; work_date: string | null; active: boolean
}
export interface Attachment { id: string; owner_id: string; kind: string; path: string }
export interface Req {
  id: string; no: number; type: ReqType; requester_id: string; work_date: string | null; status: ReqStatus
  approver_role: Role; payer_role: Role; wallet_id: string; total: number; question: string | null; answer: string | null
  created_at: string; reject_note: string | null; flags: string[]
  requester_name: string | null; approver_name: string | null; payer_name: string | null; auditor_name: string | null; asker_name: string | null
  lines: ReqLine[]; attachments: Attachment[]
}

export interface Project { id: string; name: string; kind: 'dorm' | 'capex' | 'shared' | 'real_estate'; building_id: string | null; active: boolean }

type Filter = (q: any) => any

/** live list of requests (with lines + attachments). `filter` narrows the v_requests query. */
export function useRequests(filter: Filter = (q) => q, deps: unknown[] = [], limit = 200) {
  return useLive<Req[]>(async () => {
    const { data, error } = await filter(supabase.from('v_requests').select('*')).order('created_at', { ascending: false }).limit(limit)
    if (error) throw error
    const reqs = (data || []) as Req[]
    if (!reqs.length) return []
    const ids = reqs.map((r) => r.id)
    const [{ data: lines }, { data: atts }] = await Promise.all([
      supabase.from('request_lines').select('*').in('request_id', ids),
      supabase.from('attachments').select('id, owner_id, kind, path').eq('owner_table', 'requests').in('owner_id', ids),
    ])
    return reqs.map((r) => ({
      ...r,
      total: num(r.total),
      lines: ((lines || []) as ReqLine[]).filter((l) => l.request_id === r.id).map((l) => ({ ...l, amount: num(l.amount) })),
      attachments: ((atts || []) as Attachment[]).filter((a) => a.owner_id === r.id),
    }))
  }, ['requests', 'request_lines', 'attachments', 'request_events'], deps)
}

export function useProjects() {
  return useLive<Project[]>(async () => {
    const { data, error } = await supabase.from('projects').select('*').eq('active', true).order('kind').order('id')
    if (error) throw error
    return data as Project[]
  }, [])
}

export function useWalletBalances(enabled = true) {
  return useLive<Record<string, number>>(async () => {
    if (!enabled) return {}
    const { data, error } = await supabase.from('wallet_balances').select('*')
    if (error) throw error
    return Object.fromEntries((data || []).map((w: { wallet_id: string; balance: number }) => [w.wallet_id, num(w.balance)]))
  }, ['ledger_entries'])
}
