// รายได้อื่น / รายจ่ายอื่น (in ยอดบัญชี): laundry, water machine, key cards, interest … or any kind the team adds.
// เป้อ and นุ้ย record; kinds can be added on the spot. Mistakes are reversed with a reason (the ledger is never edited).
import { useState } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt, thaiDate, todayTH } from '../lib/format'
import { WALLET_TH } from '../lib/requests'
import { num, type Role } from '../lib/types'
import { PhotoPicker, Thumbs } from '../components/Photos'
import { Loading, useAction } from '../components/ui'

interface Kind { id: number; direction: 'income' | 'expense'; name: string; active: boolean }
interface Entry {
  id: number; on_date: string; wallet_id: string; amount: number; category: string; project_id: string | null
  kind_id: number | null; photo_path: string | null; reverses: number | null; description: string | null
}
type Dir = 'income' | 'expense'
const PROJECT_TH: Record<string, string> = { N: 'นารา', P: 'ปรายดาว', SH: 'ส่วนกลาง 2 หอ' }
const DIR_TH: Record<Dir, string> = { income: 'รายได้อื่น', expense: 'รายจ่ายอื่น' }

export default function OtherMoney({ role }: { role: Role }) {
  const canRecord = ['manager', 'finance_field', 'ceo'].includes(role)
  const canReverse = ['manager', 'finance_field', 'finance', 'ceo'].includes(role)
  const { busy, run } = useAction()
  const [dir, setDir] = useState<Dir>('income')
  const empty = { kind: '', wallet: 'PC', project: 'N', amount: '', date: todayTH(), note: '', photo: [] as string[] }
  const [f, setF] = useState(empty)
  const [newKind, setNewKind] = useState<string | null>(null)

  const kinds = useLive<Kind[]>(async () => {
    const { data, error } = await supabase.from('money_kinds').select('*').eq('active', true).order('name')
    if (error) throw error
    return data as Kind[]
  }, ['money_kinds'])
  const cap = useLive<number>(async () => {
    const { data } = await supabase.from('settings').select('value').eq('key', 'other_expense_cap').maybeSingle()
    return Number((data?.value as { amount?: number } | null)?.amount ?? 3000)
  }, ['settings'])
  const list = useLive<Entry[]>(async () => {
    const { data, error } = await supabase.from('ledger_entries')
      .select('id, on_date, wallet_id, amount, category, project_id, kind_id, photo_path, reverses, description')
      .in('category', ['other_income', 'other_expense']).order('id', { ascending: false }).limit(30)
    if (error) throw error
    return data as Entry[]
  }, ['ledger_entries'])

  if (!kinds.data || !list.data) return <Loading error={kinds.error || list.error} />
  const mine = kinds.data.filter((k) => k.direction === dir)
  const reversed = new Set(list.data.filter((e) => e.reverses).map((e) => e.reverses))
  const capAmt = cap.data ?? 3000
  const overCap = dir === 'expense' && Number(f.amount) > capAmt
  const ok = f.kind && Number(f.amount) > 0 && !overCap && (dir === 'income' || f.photo.length > 0)

  return (
    <div className="panel">
      <h2>รายได้อื่น / รายจ่ายอื่น</h2>
      <p className="muted">เงินที่ไม่ใช่ค่าห้องและไม่ผ่านใบเบิก เช่น ซักผ้า ตู้น้ำ keycard ดอกเบี้ย · ไม่มีประเภทที่ต้องการ กด "+ เพิ่มประเภท" ได้เลย · นับรวมในรายงาน NOI</p>
      {canRecord && (
        <>
          <div className="row">
            {(['income', 'expense'] as const).map((d) => (
              <button key={d} className={`btn sm ${dir === d ? '' : 'ghost'}`} onClick={() => { setDir(d); setF({ ...f, kind: '' }) }}>{DIR_TH[d]}</button>
            ))}
          </div>
          <div className="row">
            <select className="inp" value={f.kind} aria-label="ประเภท" onChange={(e) => e.target.value === 'new' ? setNewKind('') : setF({ ...f, kind: e.target.value })}>
              <option value="">— เลือกประเภท —</option>
              {mine.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              <option value="new">+ เพิ่มประเภท…</option>
            </select>
            {newKind !== null && (
              <span className="inline-flex gap-1">
                <input className="inp" autoFocus placeholder={dir === 'income' ? 'เช่น ขายของเก่า' : 'เช่น ค่าอินเทอร์เน็ต'} value={newKind} onChange={(e) => setNewKind(e.target.value)} />
                <button className="btn sm" disabled={busy || newKind.trim().length < 2} onClick={() => run(async () => {
                  const id = await rpc<number>('add_money_kind', { p_direction: dir, p_name: newKind.trim() })
                  setF({ ...f, kind: String(id) }); setNewKind(null)
                  await kinds.reload()
                }, 'เพิ่มประเภทแล้ว')}>เพิ่ม</button>
                <button className="btn sm ghost" onClick={() => setNewKind(null)}>ยกเลิก</button>
              </span>
            )}
          </div>
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" placeholder="บาท" style={{ width: 110 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <select className="inp" value={f.wallet} aria-label="บัญชี" onChange={(e) => setF({ ...f, wallet: e.target.value })}>
              {['PC', 'N', 'P', 'A3'].map((w) => <option key={w} value={w}>{dir === 'income' ? 'เข้า' : 'ออกจาก'}{WALLET_TH[w]}</option>)}
            </select>
            <select className="inp" value={f.project} aria-label="อาคาร" onChange={(e) => setF({ ...f, project: e.target.value })}>
              {Object.entries(PROJECT_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="inp" type="date" value={f.date} max={todayTH()} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </div>
          <div className="row">
            <input className="inp" style={{ flex: 1, minWidth: 160 }} placeholder="หมายเหตุ (ถ้ามี)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            <PhotoPicker label={dir === 'expense' ? 'ถ่ายใบเสร็จ/สลิป *' : 'แนบรูป (ถ้ามี)'} folder="other" multiple={false} onAdd={(p) => setF({ ...f, photo: p })} />
            <Thumbs paths={f.photo} />
            <button className="btn" disabled={busy || !ok} onClick={() => run(async () => {
              await rpc('record_other_money', {
                p_direction: dir, p_kind: Number(f.kind), p_wallet: f.wallet, p_project: f.project, p_amount: Number(f.amount),
                p_on_date: f.date, p_note: f.note.trim() || null, p_photo_path: f.photo[0] || null,
              })
              setF({ ...empty, wallet: f.wallet, project: f.project })
            }, `บันทึก${DIR_TH[dir]}แล้ว`)}>บันทึก</button>
          </div>
          {overCap && <p className="flag">เกิน {fmt(capAmt)} บาท — ทำใบเบิกแทน (มีผู้อนุมัติ)</p>}
          {dir === 'expense' && <p className="muted">บันทึกตรงได้ไม่เกิน {fmt(capAmt)} บาทต่อรายการ · เกินกว่านั้นหรือจ่ายคนงาน/ร้านค้า ให้ใช้ใบเบิก (มีอนุมัติ)</p>}
        </>
      )}

      <h3>ล่าสุด</h3>
      {list.data.length === 0 && <p className="muted">ยังไม่มีรายการ</p>}
      <div className="scroll">
        <table className="t"><tbody>
          {list.data.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap">{thaiDate(e.on_date)}</td>
              <td>{e.description}{e.photo_path && <Thumbs paths={[e.photo_path]} />}
                <div className="muted text-xs">{WALLET_TH[e.wallet_id]} · {PROJECT_TH[e.project_id || ''] || e.project_id}{reversed.has(e.id) ? ' · กลับรายการแล้ว' : ''}</div></td>
              <td className={`n ${num(e.amount) > 0 ? 'ok' : 'flag'}`}>{num(e.amount) > 0 ? '+' : ''}{fmt(e.amount)}</td>
              <td>{canReverse && !e.reverses && !reversed.has(e.id) && (
                <button className="btn ghost sm" disabled={busy} onClick={() => {
                  const why = window.prompt('เหตุผลที่กลับรายการ (เช่น ใส่ยอดผิด)')
                  if (why?.trim()) run(() => rpc('reverse_other_money', { p_id: e.id, p_reason: why.trim() }), 'กลับรายการแล้ว')
                }}>กลับรายการ</button>
              )}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  )
}
