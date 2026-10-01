// เข้าสู่ระบบด้วยเบอร์โทร + PIN 6 หลัก · ครั้งแรก/ลืม PIN ใช้รหัสเปิดใช้งานจากผู้ดูแล (SPEC §3)
import { useState } from 'react'
import { edge, supabase } from '../lib/supabase'
import { useAction } from '../components/ui'

type Tokens = { access_token: string; refresh_token: string }

export default function Login() {
  const [mode, setMode] = useState<'login' | 'activate'>('login')
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [pin2, setPin2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const { busy, run } = useAction()

  const digits = (s: string, n: number) => s.replace(/\D/g, '').slice(0, n)

  async function finish(t: Tokens) {
    const { error } = await supabase.auth.setSession(t)
    if (error) throw error
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    await run(async () => {
      try {
        if (mode === 'login') {
          await finish(await edge<Tokens>('login', { phone, pin }))
        } else {
          if (pin !== pin2) throw new Error('PIN สองช่องไม่ตรงกัน')
          await finish(await edge<Tokens>('activate', { phone, code, pin }))
        }
      } catch (x) {
        setErr((x as Error).message)
      }
    })
  }

  return (
    <div className="wrap" style={{ maxWidth: 420 }}>
      <h1 className="text-[22px] font-bold mt-6 mb-1">ระบบเงินหอพัก นารา–ปรายดาว</h1>
      <p className="muted mb-4">{mode === 'login' ? 'เข้าสู่ระบบด้วยเบอร์โทรและ PIN 6 หลัก' : 'เปิดใช้งานครั้งแรก / ลืม PIN — ใช้รหัสจากผู้ดูแล แล้วตั้ง PIN ของคุณเอง'}</p>
      <form className="panel" onSubmit={submit}>
        <label className="block mb-3">
          <span className="muted">เบอร์โทร</span>
          <input className="inp w-full text-lg" type="tel" inputMode="numeric" autoComplete="username" placeholder="0xxxxxxxxx"
                 value={phone} onChange={(e) => setPhone(digits(e.target.value, 10))} required />
        </label>
        {mode === 'activate' && (
          <label className="block mb-3">
            <span className="muted">รหัสเปิดใช้งาน 8 หลัก (ใช้ได้ 24 ชม.)</span>
            <input className="inp w-full text-lg tracking-widest" inputMode="numeric" autoComplete="one-time-code"
                   value={code} onChange={(e) => setCode(digits(e.target.value, 8))} required />
          </label>
        )}
        <label className="block mb-3">
          <span className="muted">{mode === 'login' ? 'PIN' : 'ตั้ง PIN ใหม่ 6 หลัก (ผู้ดูแลจะไม่รู้ PIN นี้)'}</span>
          <input className="inp w-full text-lg tracking-widest" type="password" inputMode="numeric"
                 autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                 value={pin} onChange={(e) => setPin(digits(e.target.value, 6))} required />
        </label>
        {mode === 'activate' && (
          <label className="block mb-3">
            <span className="muted">ยืนยัน PIN อีกครั้ง</span>
            <input className="inp w-full text-lg tracking-widest" type="password" inputMode="numeric" autoComplete="new-password"
                   value={pin2} onChange={(e) => setPin2(digits(e.target.value, 6))} required />
          </label>
        )}
        {err && <p className="flag mb-2">{err}</p>}
        <button className="btn w-full justify-center py-2" disabled={busy || phone.length !== 10 || pin.length !== 6}>
          {busy ? 'กำลังตรวจ…' : mode === 'login' ? 'เข้าสู่ระบบ' : 'ตั้ง PIN และเข้าสู่ระบบ'}
        </button>
      </form>
      <button className="lnk" onClick={() => { setMode(mode === 'login' ? 'activate' : 'login'); setErr(null) }}>
        {mode === 'login' ? 'ครั้งแรก หรือ ลืม PIN → ใช้รหัสเปิดใช้งาน' : '← กลับไปเข้าสู่ระบบด้วย PIN'}
      </button>
      <p className="muted mt-4">ใส่ PIN ผิด 5 ครั้ง ระบบล็อก 15 นาที · เครื่องนี้จะจำการเข้าสู่ระบบไว้ ไม่ต้องใส่ PIN ทุกครั้ง</p>
    </div>
  )
}

export const CONSENT_VERSION = '1'

export function Consent({ onDone }: { onDone: () => void }) {
  const { busy, run } = useAction()
  return (
    <div className="wrap" style={{ maxWidth: 560 }}>
      <div className="panel mt-6">
        <h2>ความยินยอมเรื่องข้อมูลส่วนบุคคล</h2>
        <p className="mb-2">ระบบนี้เก็บข้อมูลของคุณเพื่อใช้จ่ายค่าแรงและตรวจสอบงาน ได้แก่ ชื่อ เบอร์โทร เลขบัตรประชาชนและรูปบัตร รูปถ่ายตอนลงเวลา และตำแหน่ง GPS ตอนลงเวลาเข้า-ออกงาน</p>
        <ul className="list-disc pl-5 mb-2 text-sm">
          <li>เลขบัตรประชาชนเต็มเห็นได้เฉพาะเจ้าของกิจการและฝ่ายบัญชี คนอื่นเห็นแบบปิดบางส่วน</li>
          <li>ระบบขอตำแหน่งเฉพาะตอนกดลงเวลาเท่านั้น ไม่ติดตามตลอดเวลา</li>
          <li>คุณเห็นได้เฉพาะข้อมูลของตัวเอง และขอดูหรือแก้ข้อมูลได้ที่ผู้จัดการ</li>
        </ul>
        <button className="btn" disabled={busy}
                onClick={() => run(async () => {
                  const { error } = await supabase.rpc('accept_consent', { p_version: CONSENT_VERSION })
                  if (error) throw error
                  onDone()
                })}>
          ยอมรับและเริ่มใช้งาน
        </button>
      </div>
    </div>
  )
}
