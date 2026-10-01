import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './lib/supabase'
import { useLive } from './lib/live'
import { ROLE_TH, type Alert, type Profile, type Role } from './lib/types'
import Login, { Consent } from './auth/Login'
import { Loading, Soon } from './components/ui'
import BillsView from './views/BillsView'
import AlertsView from './views/AlertsView'
import OverviewView from './views/OverviewView'
import SettingsView from './views/SettingsView'
import UsersView from './views/UsersView'
import PermissionsView from './views/PermissionsView'

// Tab names exactly as SPEC §7 / prototype. Tabs whose milestone is not built yet are hidden for now.
type Tab = { name: string; m: 1 | 2 | 3 | 4 }
const T = (name: string, m: Tab['m'] = 1): Tab => ({ name, m })
const MENU: Record<Role, Tab[]> = {
  manager: [T('ขอเบิก', 2), T('ลงเวลางาน', 3), T('รายการของฉัน', 2), T('บิลค่าห้อง'), T('ทะเบียนคนงาน', 3), T('เบิกเงินเดือน', 2), T('จดมิเตอร์', 4), T('ผู้ใช้งาน')],
  finance_field: [T('รอจ่าย', 2), T('รออนุมัติ', 2), T('บิลค่าห้อง'), T('ทะเบียนคนงาน', 3), T('เบิกเงินเดือน', 2), T('รายการทั้งหมด', 2), T('ผู้ใช้งาน')],
  finance: [T('รออนุมัติ', 2), T('บิลค่าห้อง'), T('ตรวจสอบ', 2), T('แจ้งเตือน'), T('โอน / เจ้าของ', 2), T('ยอดบัญชี', 2), T('ภาพรวม'), T('ตั้งค่า'), T('ผู้ใช้งาน')],
  auditor: [T('แจ้งเตือน'), T('ตรวจสอบ', 2), T('ภาพรวม'), T('บิลค่าห้อง'), T('รายการทั้งหมด', 2), T('สิทธิ์')],
  ceo: [T('ภาพรวม'), T('แจ้งเตือน'), T('บิลค่าห้อง'), T('ขอเบิก', 2), T('ลงเวลางาน', 3), T('รอจ่าย', 2), T('รออนุมัติ', 2), T('ตรวจสอบ', 2),
        T('ทะเบียนคนงาน', 3), T('โอน / เจ้าของ', 2), T('ยอดบัญชี', 2), T('รายการทั้งหมด', 2), T('จดมิเตอร์', 4), T('ผู้ใช้งาน'), T('ตั้งค่า'), T('สิทธิ์')],
  worker: [T('ลงเวลางาน', 3), T('ประวัติของฉัน', 3)],
}
const BUILT = 1

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileErr, setProfileErr] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadProfile = async (uid: string) => {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
    if (error) setProfileErr(error.message)
    else if (!data || !data.active) setProfileErr('บัญชีนี้ยังไม่เปิดใช้งาน หรือถูกปิด — ติดต่อผู้ดูแล')
    else { setProfile(data as Profile); setProfileErr(null) }
  }
  useEffect(() => {
    if (session?.user) loadProfile(session.user.id)
    else setProfile(null)
  }, [session?.user?.id])

  if (!configured) {
    return <div className="wrap"><div className="panel"><h2>ยังไม่ได้ตั้งค่า</h2><p className="muted">สร้างไฟล์ app/.env จาก .env.example แล้วใส่ VITE_SUPABASE_URL และ VITE_SUPABASE_ANON_KEY</p></div></div>
  }
  if (session === undefined) return <div className="wrap"><Loading /></div>
  if (!session) return <Login />
  if (profileErr) return <div className="wrap"><Loading error={profileErr} /><button className="btn ghost" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button></div>
  if (!profile) return <div className="wrap"><Loading /></div>
  if (profile.role === 'worker' && !profile.consent_at) return <Consent onDone={() => loadProfile(profile.id)} />

  const tabs = MENU[profile.role].filter((t) => t.m <= BUILT)
  const later = MENU[profile.role].filter((t) => t.m > BUILT)
  const current = tab && tabs.some((t) => t.name === tab) ? tab : tabs[0]?.name

  return (
    <div className="wrap">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h1 className="text-[22px] font-bold leading-tight m-0">ระบบเงินหอพัก นารา–ปรายดาว</h1>
          <p className="muted m-0">{profile.display_name} · {ROLE_TH[profile.role]}</p>
        </div>
        <button className="btn ghost sm" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
      </header>
      <Tabs profile={profile} tabs={tabs} current={current} onPick={setTab} />
      <main>
        {tabs.length === 0 && <Soon what="ลงเวลางาน · ประวัติของฉัน" milestone="M3" />}
        {current === 'บิลค่าห้อง' && <BillsView profile={profile} />}
        {current === 'แจ้งเตือน' && <AlertsView />}
        {current === 'ภาพรวม' && <OverviewView profile={profile} />}
        {current === 'ตั้งค่า' && <SettingsView profile={profile} />}
        {current === 'ผู้ใช้งาน' && <UsersView profile={profile} />}
        {current === 'สิทธิ์' && <PermissionsView />}
      </main>
      {later.length > 0 && tabs.length > 0 && (
        <p className="muted mt-6">ระยะถัดไปจะเพิ่มแท็บ: {later.map((t) => t.name).join(' · ')}</p>
      )}
    </div>
  )
}

function Tabs({ profile, tabs, current, onPick }: { profile: Profile; tabs: Tab[]; current?: string; onPick: (t: string) => void }) {
  const seesAlerts = ['ceo', 'finance', 'auditor'].includes(profile.role)
  const { data: alerts, connected } = useLive<Alert[]>(async () => {
    if (!seesAlerts) return []
    const { data, error } = await supabase.from('v_alerts').select('*')
    if (error) throw error
    return data as Alert[]
  }, seesAlerts ? ['bills', 'bill_rounds', 'workers', 'tenant_registrations', 'ledger_entries'] : [])
  const high = (alerts || []).filter((a) => a.level === 'high').length
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.name} className="tab" role="tab" aria-selected={t.name === current} onClick={() => onPick(t.name)}>
          {t.name}
          {t.name === 'แจ้งเตือน' && high > 0 && <span className="badge">{high}</span>}
        </button>
      ))}
      <span className="ml-auto self-center muted whitespace-nowrap pl-2" title={connected ? 'ข้อมูลอัปเดตสด' : 'ขาดการเชื่อมต่อ กำลังลองใหม่'}>
        <span className={`live ${connected ? '' : 'off'}`} />{connected ? 'สด' : 'ออฟไลน์'}
      </span>
    </nav>
  )
}
