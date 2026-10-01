// ตั้งค่า — rates, repair reserve, bank details on bills, petty-cash opening balance, tenant registration QR per room
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase, rpc } from '../lib/supabase'
import { useLive } from '../lib/live'
import { fmt } from '../lib/format'
import { num, type Profile } from '../lib/types'
import { Loading, useAction } from '../components/ui'

interface Building { id: 'N' | 'P'; name: string; bill_name: string | null; bank_name: string | null; bank_account_name: string | null; bank_account_no: string | null; contact_phone: string | null }
interface RoomLite { id: string; code: string; building_id: string; reg_token: string; status: string }

export default function SettingsView({ profile }: { profile: Profile }) {
  const canEdit = ['finance', 'ceo'].includes(profile.role)
  const { busy, run } = useAction()
  const s = useLive(async () => {
    const [{ data: settings }, { data: buildings }, { data: pc }] = await Promise.all([
      supabase.from('settings').select('key, value'),
      supabase.from('buildings').select('*').order('id'),
      supabase.rpc('pc_opening_amount'),
    ])
    const get = (k: string) => (settings || []).find((x) => x.key === k)?.value as Record<string, number> | undefined
    return { rates: get('rates'), reserve: get('repair_reserve')?.amount ?? 50000, split: get('shared_split'), buildings: (buildings || []) as Building[], pcOpening: pc == null ? null : Number(pc) }
  }, ['ledger_entries'])

  const [rates, setRates] = useState({ elec: '', water: '', pen_day: '', pen_max: '' })
  const [reserve, setReserve] = useState('')
  const [split, setSplit] = useState({ N: '', P: '' })
  const [pcAmt, setPcAmt] = useState('')
  const [pcReason, setPcReason] = useState('')
  const [bld, setBld] = useState<Record<string, Building>>({})
  useEffect(() => {
    if (!s.data) return
    const r = s.data.rates || {}
    setRates({ elec: String(r.elec ?? 8), water: String(r.water ?? 30), pen_day: String(r.pen_day ?? 100), pen_max: String(r.pen_max ?? 3100) })
    setReserve(String(s.data.reserve))
    setSplit({ N: String(s.data.split?.N ?? 32), P: String(s.data.split?.P ?? 38) })
    setBld(Object.fromEntries(s.data.buildings.map((b) => [b.id, b])))
  }, [s.data])

  if (!s.data) return <Loading error={s.error} />

  return (
    <>
      <div className="panel">
        <h2>อัตราค่าไฟ ค่าน้ำ ค่าปรับ</h2>
        <p className="muted">ใช้เป็นค่าตั้งต้นเมื่อแบบฟอร์ม Excel ไม่ได้ใส่ · แต่ละรอบบิลเก็บอัตราของรอบนั้นไว้เอง เปลี่ยนตรงนี้ไม่กระทบบิลที่ออกไปแล้ว</p>
        <div className="row">
          {([['elec', 'ค่าไฟ/หน่วย'], ['water', 'ค่าน้ำ/หน่วย'], ['pen_day', 'ค่าปรับ/วัน'], ['pen_max', 'ค่าปรับสูงสุด']] as const).map(([k, label]) => (
            <label key={k} className="muted">{label}<br />
              <input className="inp" type="number" inputMode="decimal" style={{ width: 110 }} disabled={!canEdit} value={rates[k]} onChange={(e) => setRates({ ...rates, [k]: e.target.value })} />
            </label>
          ))}
          <label className="muted">สำรองซ่อม (บาท)<br />
            <input className="inp" type="number" inputMode="decimal" style={{ width: 120 }} disabled={!canEdit} value={reserve} onChange={(e) => setReserve(e.target.value)} />
          </label>
          <label className="muted">แบ่งค่าใช้จ่ายร่วมในรายงาน NOI (จำนวนห้อง นารา : ปรายดาว)<br />
            <input className="inp" type="number" inputMode="numeric" style={{ width: 70 }} disabled={!canEdit} value={split.N} onChange={(e) => setSplit({ ...split, N: e.target.value })} /> :{' '}
            <input className="inp" type="number" inputMode="numeric" style={{ width: 70 }} disabled={!canEdit} value={split.P} onChange={(e) => setSplit({ ...split, P: e.target.value })} />
          </label>
        </div>
        {canEdit && (
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => run(async () => {
              await rpc('update_setting', { p_key: 'rates', p_value: { elec: num(rates.elec), water: num(rates.water), pen_day: num(rates.pen_day), pen_max: num(rates.pen_max) } })
              await rpc('update_setting', { p_key: 'repair_reserve', p_value: { amount: num(reserve) } })
              await rpc('update_setting', { p_key: 'shared_split', p_value: { N: num(split.N), P: num(split.P) } })
            }, 'บันทึกอัตราแล้ว')}>บันทึก</button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>ชื่อบนบิลและบัญชีรับโอน</h2>
        <p className="muted">แสดงท้ายข้อความบิลที่ส่ง LINE · ใช้กับรอบบิลที่นำเข้าหลังจากนี้</p>
        {(['N', 'P'] as const).map((id) => bld[id] && (
          <div key={id} className="row">
            <b style={{ width: 70 }}>{id === 'N' ? 'นารา' : 'ปรายดาว'}</b>
            {(['bill_name', 'bank_name', 'bank_account_name', 'bank_account_no', 'contact_phone'] as const).map((k) => (
              <input key={k} className="inp" disabled={!canEdit} style={{ width: k === 'bill_name' || k === 'bank_account_name' ? 170 : 130 }}
                     placeholder={{ bill_name: 'ชื่อบนบิล', bank_name: 'ธนาคาร', bank_account_name: 'ชื่อบัญชี', bank_account_no: 'เลขบัญชี', contact_phone: 'เบอร์ติดต่อ' }[k]}
                     value={bld[id][k] || ''} onChange={(e) => setBld({ ...bld, [id]: { ...bld[id], [k]: e.target.value } })} />
            ))}
            {canEdit && (
              <button className="btn ghost sm" disabled={busy} onClick={() => run(() => rpc('update_building', {
                p_id: id, p_bill_name: bld[id].bill_name || '', p_bank_name: bld[id].bank_name || '', p_account_name: bld[id].bank_account_name || '',
                p_account_no: bld[id].bank_account_no || '', p_contact: bld[id].contact_phone || '',
              }), 'บันทึกแล้ว')}>บันทึก</button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="panel">
          <h2>เงินสำรองนุ้ย — ยอดยกมาวันเริ่มระบบ</h2>
          {s.data.pcOpening != null && <p>ตั้งไว้ <b>{fmt(s.data.pcOpening)}</b> บาท · แก้ได้ถ้ากรอกผิด (ระบบบันทึกเป็นรายการปรับ พร้อมเหตุผล ไม่ลบของเดิม)</p>}
          <div className="row">
            <input className="inp" type="number" inputMode="decimal" placeholder={s.data.pcOpening == null ? 'นับเงินสดจริง (บาท)' : 'ยอดที่ถูกต้อง (บาท)'} value={pcAmt} onChange={(e) => setPcAmt(e.target.value)} style={{ width: 180 }} />
            {s.data.pcOpening != null && <input className="inp" placeholder="เหตุผลที่แก้ (ต้องใส่)" value={pcReason} onChange={(e) => setPcReason(e.target.value)} style={{ flex: 1, minWidth: 160 }} />}
            <button className="btn" disabled={busy || pcAmt === '' || (s.data.pcOpening != null && !pcReason.trim())}
                    onClick={() => confirm(`${s.data!.pcOpening == null ? 'ตั้ง' : 'แก้'}ยอดยกมาเงินสำรองเป็น ${fmt(pcAmt)} บาท?`) &&
                      run(async () => {
                        await rpc('set_opening_balance', { p_wallet: 'PC', p_amount: num(pcAmt), p_reason: pcReason })
                        setPcAmt(''); setPcReason('')
                      }, 'บันทึกยอดยกมาแล้ว')}>{s.data.pcOpening == null ? 'บันทึก' : 'แก้ยอด'}</button>
          </div>
        </div>
      )}

      <RoomLinks canEdit={['finance', 'finance_field', 'ceo'].includes(profile.role)} />
    </>
  )
}

function RoomLinks({ canEdit }: { canEdit: boolean }) {
  const { busy, run } = useAction()
  const [show, setShow] = useState(false)
  const rooms = useLive<RoomLite[]>(async () => {
    const { data, error } = await supabase.from('rooms').select('id, code, building_id, reg_token, status').order('code')
    if (error) throw error
    return data as RoomLite[]
  }, [])
  const [qr, setQr] = useState<Record<string, string>>({})
  const link = (r: RoomLite) => `${window.location.origin}/r/${r.reg_token}`
  useEffect(() => {
    if (!show || !rooms.data) return
    Promise.all(rooms.data.map(async (r) => [r.id, await QRCode.toDataURL(link(r), { margin: 1, width: 180 })] as const))
      .then((x) => setQr(Object.fromEntries(x)))
  }, [show, rooms.data])

  return (
    <div className="panel">
      <h2>ลิงก์ / QR ลงทะเบียนผู้เช่า</h2>
      <p className="muted">ติด QR ที่ห้อง หรือส่งลิงก์ให้ผู้เช่า → ผู้เช่ากรอก ชื่อ เบอร์ LINE ผู้ติดต่อฉุกเฉิน → นุ้ยอนุมัติในแท็บบิลค่าห้อง · แบบฟอร์มไม่แสดงข้อมูลผู้เช่าเดิม</p>
      {!rooms.data?.length ? <p className="muted">ยังไม่มีห้อง — นำเข้าแบบฟอร์ม Excel ก่อน</p> : (
        <>
          <div className="row"><button className="btn ghost" onClick={() => setShow(!show)}>{show ? 'ซ่อน' : `แสดง QR ทั้งหมด ${rooms.data.length} ห้อง`}</button>
            {show && <button className="btn ghost" onClick={() => window.print()}>พิมพ์</button>}</div>
          {show && (
            <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {rooms.data.map((r) => (
                <div key={r.id} className="border rounded-lg p-2 text-center" style={{ borderColor: 'var(--line)' }}>
                  <b>{r.code}</b> <span className="muted">{r.building_id === 'N' ? 'นารา' : 'ปรายดาว'}</span>
                  {qr[r.id] && <img src={qr[r.id]} alt={`QR ห้อง ${r.code}`} className="mx-auto my-1" width={130} height={130} />}
                  <div className="flex gap-1 justify-center flex-wrap">
                    <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(link(r))}>คัดลอกลิงก์</button>
                    {canEdit && <button className="btn ghost sm" disabled={busy} title="ลิงก์เก่าจะใช้ไม่ได้"
                      onClick={() => confirm(`เปลี่ยนลิงก์ห้อง ${r.code}? QR เดิมจะใช้ไม่ได้`) && run(async () => { await rpc('regenerate_room_token', { p_room: r.id }); await rooms.reload() }, 'เปลี่ยนลิงก์แล้ว')}>เปลี่ยน</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
