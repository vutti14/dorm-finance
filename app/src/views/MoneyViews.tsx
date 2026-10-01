// โอน / เจ้าของ · ยอดบัญชี (prototype views) — transfers, owner-paid expenses, owner draw/injection, bank checks, ledger
import { useState } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, thaiDate, todayTH } from '../lib/format'
import { WALLET_TH, useProjects, useWalletBalances } from '../lib/requests'
import { num } from '../lib/types'
import { ProjectTag } from '../components/RequestCard'
import { Loading, useAction } from '../components/ui'

const REAL = ['N', 'P', 'A3', 'PC'] as const

export function Transfers() {
  const { busy, run } = useAction()
  const [t, setT] = useState({ from: 'N', to: 'A3', amount: '', note: '' })
  const thMonth = (() => { const d = todayTH(); return `${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` })()
  const [pea, setPea] = useState({ building: 'N', month: thMonth, amount: '' })
  const [inj, setInj] = useState({ wallet: 'A3', amount: '', note: '' })
  const [draw, setDraw] = useState('')
  const av = useLive(async () => {
    const { data, error } = await supabase.rpc('owner_draw_available')
    if (error) throw error
    return data as { cash: number; deposits: number; reserve: number; pending_a3: number; available: number; a3: number }
  }, ['ledger_entries', 'requests', 'deposits'])
  const owner = useLive(async () => {
    const { data, error } = await supabase.from('v_owner_account').select('*').maybeSingle()
    if (error) throw error
    return data as Record<string, number> | null
  }, ['ledger_entries'])
  const a = av.data

  return (
    <>
      <div className="panel">
        <h2>โอนระหว่างบัญชี</h2>
        <div className="row">
          <select className="inp" value={t.from} onChange={(e) => setT({ ...t, from: e.target.value })}>{REAL.map((k) => <option key={k} value={k}>{WALLET_TH[k]}</option>)}</select>
          ไป
          <select className="inp" value={t.to} onChange={(e) => setT({ ...t, to: e.target.value })}>{REAL.map((k) => <option key={k} value={k}>{WALLET_TH[k]}</option>)}</select>
          <input className="inp" type="number" inputMode="decimal" placeholder="บาท" style={{ width: 120 }} value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} />
          <input className="inp" placeholder="หมายเหตุ" style={{ width: 160 }} value={t.note} onChange={(e) => setT({ ...t, note: e.target.value })} />
          <button className="btn" disabled={busy || !(Number(t.amount) > 0)} onClick={() => run(async () => {
            await rpc('transfer', { p_from: t.from, p_to: t.to, p_amount: Number(t.amount), p_note: t.note })
            setT({ ...t, amount: '', note: '' })
          }, 'โอนแล้ว')}>โอน</button>
        </div>
      </div>

      <div className="panel">
        <h2>เจ้าของจ่ายแทน (ค่าไฟ กฟภ.)</h2>
        <div className="row">
          <select className="inp" value={pea.building} onChange={(e) => setPea({ ...pea, building: e.target.value })}><option value="N">นารา</option><option value="P">ปรายดาว</option></select>
          <input className="inp" style={{ width: 100 }} value={pea.month} onChange={(e) => setPea({ ...pea, month: e.target.value })} aria-label="เดือนของบิล" />
          <input className="inp" type="number" inputMode="decimal" placeholder="บาท" style={{ width: 120 }} value={pea.amount} onChange={(e) => setPea({ ...pea, amount: e.target.value })} />
          <button className="btn" disabled={busy || !(Number(pea.amount) > 0)} onClick={() => run(async () => {
            await rpc('record_owner_paid', { p_building: pea.building, p_month: pea.month, p_amount: Number(pea.amount) })
            setPea({ ...pea, amount: '' })
          }, 'บันทึกค่าไฟแล้ว')}>บันทึกค่าไฟ</button>
        </div>
        <p className="muted">เป็นต้นทุนหอ แม้เงินออกจากบัญชีคุณอาร์ต · ไม่กระทบยอดเงินในบัญชีหอ</p>
      </div>

      <div className="panel">
        <h2>โอนให้เจ้าของ</h2>
        {!a ? <Loading error={av.error} /> : (
          <>
            <table className="t"><tbody>
              <tr><td>เงินใน 3 บัญชี (นารา ปรายดาว บัญชี3)</td><td className="n">{fmt(a.cash)}</td></tr>
              <tr><td>หัก เงินประกันผู้เช่าที่ถืออยู่</td><td className="n">−{fmt(a.deposits)}</td></tr>
              <tr><td>หัก สำรองซ่อม</td><td className="n">−{fmt(a.reserve)}</td></tr>
              <tr><td>หัก รายการรอจ่ายจากบัญชี3</td><td className="n">−{fmt(a.pending_a3)}</td></tr>
              <tr><td><b>โอนได้</b></td><td className="n"><b className={num(a.available) < 0 ? 'flag' : ''} style={{ fontSize: 'inherit' }}>{fmt(a.available)}</b></td></tr>
            </tbody></table>
            {num(a.available) > 0 ? (
              <div className="row">
                <input className="inp" type="number" inputMode="decimal" style={{ width: 140 }} placeholder={String(Math.floor(Math.min(num(a.available), num(a.a3))))} value={draw} onChange={(e) => setDraw(e.target.value)} />
                <button className="btn" disabled={busy || !(Number(draw) > 0)} onClick={() => run(async () => {
                  await rpc('owner_draw', { p_amount: Number(draw) })
                  setDraw('')
                }, 'โอนให้เจ้าของแล้ว')}>โอนให้เจ้าของจากบัญชี3</button>
                <span className="muted">บัญชี3 มี {fmt(a.a3)}</span>
              </div>
            ) : <p className="flag mt-2">ยังโอนไม่ได้ — เงินที่มีคือเงินประกันผู้เช่าและเงินสำรอง</p>}
          </>
        )}
      </div>

      <div className="panel">
        <h2>เจ้าของเติมเงินเข้าหอ</h2>
        <div className="row">
          <select className="inp" value={inj.wallet} onChange={(e) => setInj({ ...inj, wallet: e.target.value })}>{REAL.map((k) => <option key={k} value={k}>{WALLET_TH[k]}</option>)}</select>
          <input className="inp" type="number" inputMode="decimal" placeholder="บาท" style={{ width: 120 }} value={inj.amount} onChange={(e) => setInj({ ...inj, amount: e.target.value })} />
          <input className="inp" placeholder="หมายเหตุ" style={{ width: 160 }} value={inj.note} onChange={(e) => setInj({ ...inj, note: e.target.value })} />
          <button className="btn ghost" disabled={busy || !(Number(inj.amount) > 0)} onClick={() => run(async () => {
            await rpc('owner_injection', { p_wallet: inj.wallet, p_amount: Number(inj.amount), p_note: inj.note })
            setInj({ ...inj, amount: '', note: '' })
          }, 'บันทึกแล้ว')}>บันทึก</button>
        </div>
        <p className="muted">ไม่ใช่รายได้หอ — ลดยอดที่เจ้าของค้างหอ</p>
      </div>

      {owner.data && <OwnerAccount o={owner.data} />}
    </>
  )
}

export function OwnerAccount({ o }: { o: Record<string, number> }) {
  const v = num(o.owner_owes_dorm)
  return (
    <div className="panel">
      <h2>บัญชีระหว่างเจ้าของกับหอ</h2>
      <table className="t"><tbody>
        <tr><td>หอจ่ายแทนอสังหาฯ/ส่วนตัว (ม.ค.–ก.ย.)</td><td className="n">{fmt(o.re_opening)}</td></tr>
        <tr><td>+ ใหม่ในระบบนี้</td><td className="n">{fmt(o.re_new)}</td></tr>
        <tr><td>เจ้าของจ่ายค่าไฟแทนหอ</td><td className="n">−{fmt(num(o.owner_paid_opening) + num(o.owner_paid_new))}</td></tr>
        <tr><td>เจ้าของเติมเงินเข้าหอ</td><td className="n">−{fmt(num(o.injection_opening) + num(o.injection_new))}</td></tr>
        <tr><td><b>{v > 0 ? 'เจ้าของค้างหอ' : 'หอค้างเจ้าของ'}</b></td><td className="n"><b>{fmt(Math.abs(v))}</b></td></tr>
        <tr><td className="muted">โอนให้เจ้าของแล้ว (ในระบบนี้ · ไม่นับในยอดค้าง)</td><td className="n muted">{fmt(o.draws_new)}</td></tr>
      </tbody></table>
    </div>
  )
}

// ---------------------------------------------------------------- ยอดบัญชี
interface Rec { wallet_id: string; bank_balance: number; system_balance: number; checked_at: string }
interface Led { id: number; on_date: string; wallet_id: string; amount: number; category: string; project_id: string | null; description: string | null }

export function Balances({ canCheck }: { canCheck: boolean }) {
  const bal = useWalletBalances()
  const projects = useProjects()
  const { busy, run } = useAction()
  const [bank, setBank] = useState<Record<string, string>>({})
  const rec = useLive<Rec[]>(async () => {
    const { data, error } = await supabase.from('v_bank_reconciliation').select('*')
    if (error) throw error
    return data as Rec[]
  }, ['bank_checks', 'ledger_entries'])
  const led = useLive<Led[]>(async () => {
    const { data, error } = await supabase.from('ledger_entries').select('id, on_date, wallet_id, amount, category, project_id, description').order('id', { ascending: false }).limit(40)
    if (error) throw error
    return data as Led[]
  }, ['ledger_entries'])
  if (!bal.data) return <Loading error={bal.error} />
  return (
    <>
      <div className="panel">
        <h2>ยอดคงเหลือ — ระบบคำนวณเอง</h2>
        <div className="scroll">
          <table className="t">
            <thead><tr><th>บัญชี</th><th className="n">ในระบบ</th><th>ยอดในแอปธนาคาร</th><th>กระทบยอดล่าสุด</th></tr></thead>
            <tbody>
              {REAL.map((k) => {
                const r = rec.data?.find((x) => x.wallet_id === k)
                const diff = r ? num(r.bank_balance) - num(r.system_balance) : null
                return (
                  <tr key={k}>
                    <td>{WALLET_TH[k]}</td>
                    <td className="n">{bal.data![k] != null ? fmt(bal.data![k]) : <span className="muted">ยังไม่ตั้งยอด</span>}</td>
                    <td>{k !== 'PC' && canCheck ? (
                      <span className="inline-flex gap-1">
                        <input className="inp" type="number" inputMode="decimal" style={{ width: 120 }} placeholder="ใส่ยอดจริง" value={bank[k] ?? ''} onChange={(e) => setBank({ ...bank, [k]: e.target.value })} />
                        <button className="btn sm" disabled={busy || bank[k] === undefined || bank[k] === ''} onClick={() => run(async () => {
                          const x = await rpc<{ diff: number }>('record_bank_check', { p_wallet: k, p_balance: Number(bank[k]) })
                          setBank({ ...bank, [k]: '' })
                          return x
                        }, (x) => Math.abs(num(x.diff)) < 0.005 ? 'ตรงกับธนาคาร ✓' : `ไม่ตรง ต่าง ${fmt(x.diff)} — ขึ้นแจ้งเตือนแล้ว`)}>บันทึก</button>
                      </span>) : k === 'PC' ? <span className="muted">เงินสด</span> : null}</td>
                    <td>{r ? (Math.abs(diff!) < 0.005
                      ? <span className="ok">ตรง ✓ <span className="muted">{thaiDate(r.checked_at.slice(0, 10))}</span></span>
                      : <span className="flag">ต่าง {fmt(diff)} <span className="muted">{thaiDate(r.checked_at.slice(0, 10))}</span></span>) : <span className="muted">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">กระทบยอดสัปดาห์ละครั้ง ไม่ตรง = ขึ้นแจ้งเตือนให้หน่อย</p>
      </div>
      <div className="panel">
        <h2>เงินเข้า-ออกล่าสุด</h2>
        {!led.data || !projects.data ? <Loading error={led.error} /> : (
          <div className="scroll">
            <table className="t">
              <thead><tr><th>วันที่</th><th>บัญชี</th><th>รายการ</th><th>โครงการ</th><th className="n">เข้า/ออก</th></tr></thead>
              <tbody>
                {led.data.map((x) => (
                  <tr key={x.id}>
                    <td className="whitespace-nowrap">{thaiDate(x.on_date)}</td>
                    <td>{WALLET_TH[x.wallet_id] || x.wallet_id}</td>
                    <td>{x.description}</td>
                    <td>{x.project_id && <ProjectTag id={x.project_id} projects={projects.data!} />}</td>
                    <td className="n" style={{ color: num(x.amount) < 0 ? 'var(--out)' : 'var(--in)' }}>{fmt(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
