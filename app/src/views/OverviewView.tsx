// ภาพรวม (M1): round KPIs per building, alerts, wallet balances, owner account. Full NOI dashboard = M5.
import { supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, round2 } from '../lib/format'
import { num, type Profile, type Round } from '../lib/types'
import { Loading, Stat } from '../components/ui'
import { useAlerts } from './AlertsView'

interface Summary {
  building_id: 'N' | 'P'; billed_rooms: number; vacant_rooms: number; open_rooms: number; closed_rooms: number
  billed_total: number; received: number; outstanding: number; rent: number; elec: number; water: number
}
const WALLET_TH: Record<string, string> = { N: 'บัญชีนารา', P: 'บัญชีปรายดาว', A3: 'บัญชี3 (กลาง)', PC: 'เงินสำรองนุ้ย' }

export default function OverviewView({ profile }: { profile: Profile }) {
  const money = ['ceo', 'finance', 'auditor'].includes(profile.role)
  const data = useLive(async () => {
    const { data: rounds, error } = await supabase.from('bill_rounds').select('*').order('due_date', { ascending: false }).limit(1)
    if (error) throw error
    const R = (rounds?.[0] as Round) || null
    const sums = R ? ((await supabase.from('v_round_summary').select('*').eq('round_id', R.id)).data as Summary[]) : []
    const wallets = money ? ((await supabase.from('wallet_balances').select('*')).data as { wallet_id: string; balance: number }[]) : []
    const deposits = money ? ((await supabase.from('v_deposits_held').select('held')).data || []).reduce((s, r) => s + num(r.held), 0) : 0
    const owner = money ? ((await supabase.from('settings').select('value').eq('key', 'owner_opening').maybeSingle()).data?.value as Record<string, number> | undefined) : undefined
    const reserve = money ? num(((await supabase.from('settings').select('value').eq('key', 'repair_reserve').maybeSingle()).data?.value as { amount?: number })?.amount ?? 50000) : 0
    return { R, sums: sums || [], wallets: wallets || [], deposits, owner, reserve }
  }, ['bills', 'bill_rounds', 'ledger_entries', 'deposits'])
  const alerts = useAlerts()

  if (!data.data) return <Loading error={data.error} />
  const { R, sums, wallets, deposits, owner, reserve } = data.data
  const tot = (k: keyof Summary) => round2(sums.reduce((s, x) => s + num(x[k]), 0))
  const bal = (id: string) => num(wallets.find((w) => w.wallet_id === id)?.balance)
  const cash = bal('N') + bal('P') + bal('A3')

  return (
    <>
      {R && (
        <div className="panel">
          <h2>รอบบิล {R.label} · {R.status === 'draft' ? 'ยังไม่วางบิล' : 'วางบิลแล้ว'}</h2>
          <div className="grid-stats">
            <Stat value={fmt(tot('billed_total'))} label={`วางบิล ${tot('billed_rooms')} ห้อง`} />
            <Stat value={fmt(tot('received'))} label={`รับแล้ว · ปิด ${tot('closed_rooms')} ห้อง`} tone="ok" />
            <Stat value={fmt(tot('outstanding'))} label={`ค้าง ${tot('open_rooms')} ห้อง`} tone="bad" />
            <Stat value={tot('vacant_rooms')} label="ว่าง" />
          </div>
          <div className="scroll mt-3">
            <table className="t">
              <thead><tr><th>อาคาร</th><th className="n">ค่าเช่า</th><th className="n">ค่าไฟ</th><th className="n">ค่าน้ำ</th><th className="n">วางบิล</th><th className="n">รับแล้ว</th><th className="n">ค้าง</th></tr></thead>
              <tbody>
                {(['N', 'P'] as const).map((b) => {
                  const s = sums.find((x) => x.building_id === b)
                  return s ? (
                    <tr key={b}><td><span className={`tag ${b === 'N' ? 'A' : 'B'}`} style={{ marginLeft: 0 }}>{b === 'N' ? 'นารา' : 'ปรายดาว'}</span></td>
                      <td className="n">{fmt(s.rent)}</td><td className="n">{fmt(s.elec)}</td><td className="n">{fmt(s.water)}</td>
                      <td className="n"><b>{fmt(s.billed_total)}</b></td><td className="n">{fmt(s.received)}</td><td className="n">{fmt(s.outstanding)}</td></tr>
                  ) : null
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>แจ้งเตือน {alerts.data?.length ?? '…'} เรื่อง</h2>
        {(alerts.data || []).slice(0, 4).map((a, i) => <div key={i} className={`al ${a.level}`}><b>{a.title}</b></div>)}
        {(alerts.data?.length || 0) > 4 && <p className="muted">ดูทั้งหมดที่แท็บแจ้งเตือน</p>}
      </div>

      {money && (
        <div className="panel">
          <h2>ยอดเงิน — ระบบคำนวณจากรายการเงินเข้า-ออก</h2>
          <div className="scroll"><table className="t"><tbody>
            {Object.entries(WALLET_TH).map(([k, v]) => (
              <tr key={k}><td>{v}</td><td className="n">{wallets.some((w) => w.wallet_id === k) ? fmt(bal(k)) : <span className="muted">ยังไม่ตั้งยอดยกมา</span>}</td></tr>
            ))}
            <tr><td>หัก เงินประกันผู้เช่าที่ถืออยู่</td><td className="n">−{fmt(deposits)}</td></tr>
            <tr><td>หัก สำรองซ่อม</td><td className="n">−{fmt(reserve)}</td></tr>
            <tr><td><b>เงินที่ไม่ติดภาระ (3 บัญชี)</b></td><td className="n"><b className={cash - deposits - reserve < 0 ? 'flag' : ''}>{fmt(cash - deposits - reserve)}</b></td></tr>
          </tbody></table></div>
          <p className="muted">ระยะ M2 จะหักรายการรอจ่ายจากบัญชี3 และเปิดปุ่มโอนให้เจ้าของ</p>
        </div>
      )}

      {money && owner && (
        <div className="panel">
          <h2>บัญชีระหว่างเจ้าของกับหอ (ยกมา ณ {owner.as_of ? String(owner.as_of) : '30 ก.ย. 69'})</h2>
          <table className="t"><tbody>
            <tr><td>หอจ่ายแทนอสังหาฯ/ส่วนตัว (ม.ค.–ก.ย.)</td><td className="n">{fmt(owner.real_estate)}</td></tr>
            <tr><td>เจ้าของจ่ายค่าไฟแทนหอ</td><td className="n">−{fmt(owner.owner_paid)}</td></tr>
            <tr><td>เจ้าของเติมเงินเข้าหอ</td><td className="n">−{fmt(owner.injection)}</td></tr>
            {(() => {
              const v = num(owner.real_estate) - num(owner.owner_paid) - num(owner.injection)
              return <tr><td><b>{v > 0 ? 'เจ้าของค้างหอ' : 'หอค้างเจ้าของ'}</b></td><td className="n"><b>{fmt(Math.abs(v))}</b></td></tr>
            })()}
          </tbody></table>
        </div>
      )}
    </>
  )
}
