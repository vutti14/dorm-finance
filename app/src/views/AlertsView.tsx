import { supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import type { Alert } from '../lib/types'
import { Loading } from '../components/ui'

export function useAlerts() {
  return useLive<Alert[]>(async () => {
    const { data, error } = await supabase.from('v_alerts').select('*')
    if (error) throw error
    return (data as Alert[]).sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1))
  }, ['bills', 'bill_rounds', 'workers', 'tenant_registrations', 'ledger_entries', 'deposits'])
}

export default function AlertsView() {
  const { data, error } = useAlerts()
  if (!data) return <Loading error={error} />
  return (
    <div className="panel">
      <h2>สิ่งที่ต้องดูวันนี้ ({data.length})</h2>
      <p className="muted">ระบบตรวจให้อัตโนมัติจากบิล ทะเบียนคนงาน และยอดบัญชี · ระยะ M2 จะเพิ่มใบเบิก การลงเวลา และการกระทบยอดธนาคาร</p>
      {data.length === 0 && <p className="ok">ไม่มีเรื่องผิดปกติ</p>}
      {data.map((a, i) => (
        <div key={i} className={`al ${a.level}`}>
          <b>{a.title}</b>
          {a.detail && <div className="muted">{a.detail}</div>}
        </div>
      ))}
    </div>
  )
}
