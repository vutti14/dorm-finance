// Banner for the CEO: every CEO-level account change stays here until acknowledged (owner decision 1 ต.ค. 69)
import { supabase, rpc } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmtPhone } from '../lib/format'
import { useAction } from './ui'

interface Ev { id: number; kind: string; display_name: string | null; phone: string | null; actor_name: string | null; at: string }
const KIND_TH: Record<string, string> = {
  ceo_created: 'สร้างบัญชีระดับ CEO', ceo_granted: 'ให้สิทธิ์ CEO', ceo_revoked: 'ถอดสิทธิ์ CEO', ceo_disabled: 'ปิดบัญชี CEO', ceo_enabled: 'เปิดบัญชี CEO',
}

export default function CeoWatch({ isCeo }: { isCeo: boolean }) {
  const { busy, run } = useAction()
  const ev = useLive<Ev[]>(async () => {
    if (!isCeo) return []
    const { data, error } = await supabase.from('security_events').select('*').is('acknowledged_at', null).order('at')
    if (error) throw error
    return data as Ev[]
  }, isCeo ? ['security_events'] : [])
  if (!ev.data?.length) return null
  return (
    <div className="panel" style={{ borderLeft: '4px solid var(--out)' }}>
      <h2 className="flag" style={{ fontSize: 16 }}>มีการเปลี่ยนบัญชีระดับ CEO — ตรวจว่าเป็นคนที่คุณอนุญาต</h2>
      {ev.data.map((e) => (
        <div key={e.id} className="row" style={{ marginTop: 4 }}>
          <span><b>{KIND_TH[e.kind] || e.kind}</b>: {e.display_name} ({fmtPhone(e.phone)}) · โดย {e.actor_name || 'ผู้ดูแลระบบ'} · {new Date(e.at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</span>
          <button className="btn sm" disabled={busy} onClick={() => run(() => rpc('ack_security_event', { p_id: e.id }), 'รับทราบแล้ว')}>รับทราบ</button>
        </div>
      ))}
      <p className="muted">ถ้าไม่ได้อนุญาต: ไปแท็บผู้ใช้งาน → ปิดบัญชีนั้นทันที</p>
    </div>
  )
}
