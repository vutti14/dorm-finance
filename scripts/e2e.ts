// End-to-end check of every function through the real Supabase APIs (auth, edge functions, RPC, storage, realtime),
// acting as each role — then deletes ONLY what it created. Meant for a freshly deployed project BEFORE the real data
// is loaded; it refuses to run on a database that already has bill rounds, money or requests.
//
//   cd scripts && npm ci
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… DATABASE_URL=… npx tsx e2e.ts
//
// Keys come from the environment only (never commit them). Test people use phones 099000xxxx; test rooms start "ทดสอบ".
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL_ = need('SUPABASE_URL'), ANON = need('SUPABASE_ANON_KEY'), SERVICE = need('SUPABASE_SERVICE_ROLE_KEY'), DB = need('DATABASE_URL')
function need(k: string): string { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v }

const PHONE = (n: number) => `09900000${String(n).padStart(2, '0')}`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const METER_JPG = readFileSync(resolve(__dirname, 'fixtures/meter-sample.jpg'))   // shows 01180 + red 7, sticker ทดสอบ101
const results: { name: string; ok: boolean; note?: string }[] = []
const uploaded: string[] = []
const created = { users: [] as string[] }
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(URL_, SERVICE, opts)

async function step(name: string, fn: () => Promise<string | void>) {
  try { const note = await fn(); results.push({ name, ok: true, note: note || undefined }); console.log(`✅ ${name}${note ? ' — ' + note : ''}`) }
  catch (e) { results.push({ name, ok: false, note: (e as Error).message }); console.log(`❌ ${name} — ${(e as Error).message}`) }
}
function expect(cond: unknown, msg: string) { if (!cond) throw new Error(msg) }
async function rpc<T = any>(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}
async function rpcFails(c: SupabaseClient, fn: string, args: Record<string, unknown>, re: RegExp) {
  const { error } = await c.rpc(fn, args)
  expect(error && re.test(error.message), `${fn} ควรถูกปฏิเสธ (${re}) แต่ได้: ${error?.message ?? 'สำเร็จ'}`)
}
async function edge(name: string, body: unknown, token?: string) {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token || ANON}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as any }
}
async function clientFor(phone: string, pin: string) {
  const r = await edge('login', { phone, pin })
  expect(r.status === 200, `login ${phone}: ${r.body.error}`)
  const c = createClient(URL_, ANON, opts)
  await c.auth.setSession({ access_token: r.body.access_token, refresh_token: r.body.refresh_token })
  await c.realtime.setAuth(r.body.access_token)
  return { c, token: r.body.access_token as string }
}
async function upload(c: SupabaseClient, path: string, body: Buffer = PNG) {
  const { error } = await c.storage.from('photos').upload(path, body, { contentType: 'image/jpeg' })
  if (error) throw new Error(`upload ${path}: ${error.message}`)
  uploaded.push(path)
  return path
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())

async function main() {
  const db = new pg.Client({ connectionString: DB })
  await db.connect()
  const busy = (await db.query(`select (select count(*) from bill_rounds) + (select count(*) from ledger_entries)
                                     + (select count(*) from requests) + (select count(*) from attendance) n`)).rows[0].n
  if (Number(busy) > 0) throw new Error('ฐานข้อมูลนี้มีข้อมูลจริงแล้ว (รอบบิล/เงิน/ใบเบิก/ลงเวลา) — สคริปต์นี้ใช้กับ project ที่เพิ่งขึ้นระบบเท่านั้น')
  const t0 = (await db.query(`select now() t`)).rows[0].t
  const snap = {
    settings: (await db.query(`select key, value, updated_by, updated_at from settings`)).rows,
    buildings: (await db.query(`select * from buildings`)).rows,
    workers: (await db.query(`select id from workers`)).rows.map((r) => r.id),
    kinds: (await db.query(`select id from money_kinds`)).rows.map((r) => r.id),
    rooms: (await db.query(`select id from rooms`)).rows.map((r) => r.id),
    tenants: (await db.query(`select id from tenants`)).rows.map((r) => r.id),
  }

  try {
    await run(db)
  } finally {
    await cleanup(db, t0, snap)
    await db.end()
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\nสรุป: ผ่าน ${results.length - bad.length}/${results.length}`)
  if (bad.length) { for (const b of bad) console.log(`  ❌ ${b.name}: ${b.note}`); process.exitCode = 1 }
}

async function run(db: pg.Client) {
  // ---------------------------------------------------------------- accounts
  const PIN = { ceo: '482915', pao: '603174', nui: '715028', kwang: '826391', noi: '937402', w: '148260' }
  let ceo!: SupabaseClient, ceoToken = ''
  await step('บัญชี CEO แรก (สร้างแบบเดียวกับคู่มือ) + ล็อกอินด้วยเบอร์ + PIN', async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: `p${PHONE(1)}@dorm.internal`, password: PIN.ceo, email_confirm: true })
    if (error) throw error
    created.users.push(data.user.id)
    const { error: pe } = await admin.from('profiles').insert({ id: data.user.id, display_name: 'ทดสอบ CEO', phone: PHONE(1), role: 'ceo' })
    if (pe) throw pe
    ;({ c: ceo, token: ceoToken } = await clientFor(PHONE(1), PIN.ceo))
  })

  const C: Record<string, SupabaseClient> = {}
  const tokens: Record<string, string> = {}
  const W: Record<string, string> = {}
  await step('ทะเบียนคนงาน: เพิ่มช่างทดสอบ (ครบทุกช่อง)', async () => {
    W.a = await rpc(ceo, 'upsert_worker', { p: { full_name: 'ทดสอบ ช่างหนึ่ง', kind: 'technician', daily_rate: 400, phone: PHONE(20), national_id: '1101700230708', id_card_path: 'id/test.jpg' } })
    expect(W.a, 'ไม่ได้ id คนงาน')
  })
  await step('แท็บผู้ใช้งาน: CEO สร้างบัญชีทุกบทบาท → ได้รหัสเปิดใช้ → แต่ละคนตั้ง PIN เอง', async () => {
    const people: [string, string, string, number][] = [['pao', 'ทดสอบ เป้อ', 'manager', 2], ['nui', 'ทดสอบ นุ้ย', 'finance_field', 3],
      ['kwang', 'ทดสอบ กวาง', 'finance', 4], ['noi', 'ทดสอบ หน่อย', 'auditor', 5], ['w', 'ทดสอบ ช่างหนึ่ง', 'worker', 20]]
    for (const [k, name, role, n] of people) {
      const r = await edge('admin-create-user', { phone: PHONE(n), display_name: name, role, worker_id: role === 'worker' ? W.a : undefined }, ceoToken)
      expect(r.status === 200, `สร้าง ${name}: ${r.body.error}`)
      created.users.push(r.body.profile_id)
      const a = await edge('activate', { phone: PHONE(n), code: r.body.activation_code, pin: PIN[k as keyof typeof PIN] })
      expect(a.status === 200, `เปิดใช้ ${name}: ${a.body.error}`)
      ;({ c: C[k], token: tokens[k] } = await clientFor(PHONE(n), PIN[k as keyof typeof PIN]))
    }
    return '5 บัญชี'
  })
  await step('ความปลอดภัยล็อกอิน: PIN ผิด 5 ครั้ง → ล็อก 15 นาที · ออกรหัสใหม่ปลดได้', async () => {
    for (let i = 0; i < 5; i++) await edge('login', { phone: PHONE(5), pin: '000111' })
    const r = await edge('login', { phone: PHONE(5), pin: PIN.noi })
    expect(r.status === 429, `ควรถูกล็อก แต่ได้ ${r.status}`)
    const re = await edge('admin-create-user', { phone: PHONE(5), reissue: true }, ceoToken)
    expect(re.status === 200, re.body.error)
    await db.query(`delete from login_attempts where phone = $1`, [PHONE(5)])   // the lock window is 15 min; clear it for the rest of the run
    const a = await edge('activate', { phone: PHONE(5), code: re.body.activation_code, pin: PIN.noi })
    expect(a.status === 200, a.body.error)
    ;({ c: C.noi } = await clientFor(PHONE(5), PIN.noi))
  })
  await step('เป้อสร้างบัญชีระดับ CEO ได้ → ขึ้นแจ้งเตือนบัญชี CEO ให้อาร์ต', async () => {
    const r = await edge('admin-create-user', { phone: PHONE(9), display_name: 'ทดสอบ CEO สำรอง', role: 'ceo' }, tokens.pao)
    expect(r.status === 200, r.body.error)
    created.users.push(r.body.profile_id)
    const { data } = await ceo.from('security_events').select('kind').order('id', { ascending: false }).limit(1)
    expect(data?.[0]?.kind === 'ceo_created', 'ไม่มีแจ้งเตือน ceo_created')
  })

  // ---------------------------------------------------------------- settings
  await step('ตั้งค่า: อัตราค่าไฟ/น้ำ · บัญชีรับโอน · ยอดยกมาเงินสำรอง (+แก้พร้อมเหตุผล)', async () => {
    await rpc(C.kwang, 'update_setting', { p_key: 'rates', p_value: { elec: 8, water: 30, pen_day: 100, pen_max: 3100 } })
    await rpc(C.kwang, 'update_building', { p_id: 'N', p_bill_name: 'นารา แมนชั่น', p_bank_name: 'ทดสอบ', p_account_name: 'ทดสอบ', p_account_no: '000-0-00000-0', p_contact: PHONE(2) })
    await rpc(C.kwang, 'set_opening_balance', { p_wallet: 'PC', p_amount: 10000 })
    await rpcFails(C.kwang, 'set_opening_balance', { p_wallet: 'PC', p_amount: 9000 }, /เหตุผล/)
    await rpc(C.kwang, 'set_opening_balance', { p_wallet: 'PC', p_amount: 9500, p_reason: 'ทดสอบ นับใหม่' })
    for (const w of ['N', 'P', 'A3']) await rpc(ceo, 'owner_injection', { p_wallet: w, p_amount: 100000, p_note: 'ทดสอบ เงินตั้งต้น' })
  })

  // ---------------------------------------------------------------- billing (Excel import path)
  const label = `ทดสอบ ${today()}`
  let round = ''
  const rooms = [
    { code: 'ทดสอบ101', building: 'N', status: 'occupied', base_rent: 4000, tenant_name: 'ผู้เช่าทดสอบ', tenant_phone: PHONE(30) },
    { code: 'ทดสอบ102', building: 'N', status: 'vacant', base_rent: 3500 },
    { code: 'ทดสอบB1', building: 'P', status: 'occupied', base_rent: 3000, water_flat: 150 },
    { code: 'ทดสอบB2', building: 'P', status: 'staff', base_rent: 2000, elec_rate_override: 4.5, water_flat: 150 },
  ]
  await step('บิลค่าห้อง: นำเข้า Excel → ห้องไม่จดไฟวางบิลไม่ได้ → จดครบแล้ววางบิล', async () => {
    const payload = {
      settings: { label, meter_month: 'ทดสอบ', issue_date: today(), due_date: today() },
      rooms, items: [{ code: 'ทดสอบ101', description: 'ทดสอบ ค่าจอดรถ', amount: 500 }], carry: [], workers: [],
      meters: [{ code: 'ทดสอบ101', elec_prev: 1000, elec_curr: 1100, water_prev: 10, water_curr: 15 }, { code: 'ทดสอบB2', elec_prev: 50, elec_curr: 80 }],
    }
    const r = await rpc(C.pao, 'import_round', { payload })
    round = r.round_id
    expect(JSON.stringify(r.blocking).includes('ทดสอบB1'), 'ห้องไม่จดไฟต้องขึ้น blocking')
    await rpcFails(C.nui, 'issue_round', { p_round: round }, /ยังไม่จดไฟ/)
    const rid = (await db.query(`select id from rooms where code = 'ทดสอบB1'`)).rows[0].id
    await rpc(C.pao, 'record_meter', { p_round: round, p_room: rid, p_kind: 'elec', p_curr: 520, p_prev: 500 })
    const done = await rpc(C.nui, 'issue_round', { p_round: round })
    return `เปิดบิล ${done.open_bills} ห้อง`
  })
  const bill = async (code: string, rd = round) => (await db.query(`select b.* from bills b join rooms r on r.id = b.room_id where r.code = $1 and b.round_id = $2`, [code, rd])).rows[0]
  await step('ยอดบิลถูก: 4,000 + ไฟ 100×8 + น้ำ 5×30 + จอดรถ 500 = 5,450 · ห้องพนักงานไม่รับเงินจริง', async () => {
    const b = await bill('ทดสอบ101')
    expect(Number(b.total) === 5450, `ได้ ${b.total}`)
    expect((await bill('ทดสอบB2')).status === 'welfare', 'ห้องพนักงานต้องเป็น welfare')
  })
  await step('รับเงิน: บางส่วน → ปิดห้อง · รับเกินไม่ได้ · กดพร้อมกัน 2 เครื่องสำเร็จครั้งเดียว', async () => {
    const b = await bill('ทดสอบ101')
    await rpc(C.kwang, 'record_receipt', { p_bill: b.id, p_amount: 2000, p_on_date: today() })
    await rpcFails(C.kwang, 'record_receipt', { p_bill: b.id, p_amount: 9999, p_on_date: today() }, /รับเกิน/)
    const two = await Promise.all([C.kwang.rpc('record_receipt', { p_bill: b.id, p_amount: 3450, p_on_date: today() }),
                                   ceo.rpc('record_receipt', { p_bill: b.id, p_amount: 3450, p_on_date: today() })])
    expect(two.filter((x) => !x.error).length === 1, 'ต้องสำเร็จครั้งเดียว')
    expect((await bill('ทดสอบ101')).status === 'closed', 'ต้องปิดห้อง')
  })
  await step('ค่าปรับ (เพดาน) · ปรับบิลต้องมีเหตุผล · เงินประกันรับ/คืน', async () => {
    const b = await bill('ทดสอบB1')
    await rpc(C.nui, 'add_penalty', { p_bill: b.id, p_amount: 100 })
    await rpcFails(C.nui, 'add_penalty', { p_bill: b.id, p_amount: 5000 }, /เพดาน/)
    await rpcFails(C.kwang, 'add_bill_item', { p_bill: b.id, p_description: 'ส่วนลด', p_amount: -50, p_reason: '' }, /เหตุผล/)
    await rpc(C.kwang, 'add_bill_item', { p_bill: b.id, p_description: 'ส่วนลด', p_amount: -50, p_reason: 'ทดสอบ' })
    await rpc(C.kwang, 'record_deposit', { p_room_code: 'ทดสอบ101', p_kind: 'deposit', p_amount: 4000, p_on_date: today() })
    await rpcFails(C.kwang, 'record_deposit', { p_room_code: 'ทดสอบ101', p_kind: 'refund', p_amount: 5000, p_on_date: today() }, /คืนเกิน/)
    await rpc(C.kwang, 'record_deposit', { p_room_code: 'ทดสอบ101', p_kind: 'refund', p_amount: 1000, p_on_date: today() })
  })
  await step('ลงทะเบียนผู้เช่าผ่าน QR (ไม่ต้องล็อกอิน) → เจ้าหน้าที่อนุมัติ', async () => {
    const anon = createClient(URL_, ANON, opts)
    const tok = (await db.query(`select reg_token from rooms where code = 'ทดสอบ102'`)).rows[0].reg_token
    const info = await rpc(anon, 'registration_room', { p_token: tok })
    expect(info.room === 'ทดสอบ102', 'ไม่เจอห้อง')
    await rpc(anon, 'submit_tenant_registration', { p_token: tok, p: { name: 'ผู้เช่าใหม่ทดสอบ', phone: PHONE(31), emergency_name: 'ญาติทดสอบ', emergency_phone: PHONE(32), accepted: true } })
    const { data } = await C.nui.from('tenant_registrations').select('id').eq('status', 'pending').limit(1)
    await rpc(C.nui, 'decide_tenant_registration', { p_id: data![0].id, p_approve: true })
  })
  await step('RLS: ช่างไม่เห็นบิล/เงิน · หน่อยแก้อะไรไม่ได้ · ข้อความผิดเป็นภาษาไทย', async () => {
    const { data: b } = await C.w.from('bills').select('id').limit(1)
    const { data: l } = await C.w.from('ledger_entries').select('id').limit(1)
    expect((b?.length ?? 0) === 0 && (l?.length ?? 0) === 0, 'ช่างเห็นข้อมูลที่ไม่ควรเห็น')
    await rpcFails(C.noi, 'record_receipt', { p_bill: (await bill('ทดสอบB1')).id, p_amount: 1, p_on_date: today() }, /ไม่มีสิทธิ์/)
  })

  // ---------------------------------------------------------------- realtime
  await step('Realtime: กวางรับเงิน → เครื่องเป้อเห็นภายในไม่กี่วินาที (SPEC §10 ข้อ 2)', async () => {
    const got = new Promise<number>((res, rej) => {
      let t0 = Date.now()
      // the app listens to live_pulse (one signal per table per transaction), not to row streams
      const ch = C.pao.channel('e2e-bills').on('postgres_changes', { event: '*', schema: 'public', table: 'live_pulse', filter: 'topic=eq.bills' },
        () => { res(Date.now() - t0); C.pao.removeChannel(ch) })
      // act only after the server confirms the database subscription (the app instead reloads on connect)
      ch.on('system', {}, async (m: { extension?: string; status?: string }) => {
        if (m.extension === 'postgres_changes' && m.status === 'ok') {
          t0 = Date.now()
          try {
            const b = await bill('ทดสอบB1')
            const { error } = await C.kwang.rpc('record_receipt', { p_bill: b.id, p_amount: 100, p_on_date: today() })
            if (error) rej(error)
          } catch (e) { rej(e) }
        }
      })
      ch.subscribe()
      setTimeout(() => rej(new Error('ไม่ได้รับการแจ้งภายใน 15 วินาที')), 15000)
    })
    return `${await got} ms`
  })

  // ---------------------------------------------------------------- meters (M4) + carry-forward
  let round2 = ''
  await step('จดมิเตอร์: เริ่มรอบใหม่ในแอป → เลขครั้งก่อนมาเอง → ถ่ายรูป (Storage จริง) → บิลคำนวณทันที', async () => {
    const r = await rpc(C.pao, 'start_round', { p_label: `${label} รอบ2`, p_meter_month: 'ทดสอบ', p_issue_date: today(), p_due_date: today() })
    round2 = r.round_id
    const rid = (await db.query(`select id from rooms where code = 'ทดสอบ101'`)).rows[0].id
    const sheet = await rpc<any[]>(C.pao, 'meter_sheet', { p_round: round2 })
    expect(Number(sheet.find((s) => s.code === 'ทดสอบ101').elec_prev) === 1100, 'เลขครั้งก่อนไม่ถูก')
    const photo = await upload(C.pao, `meters/${round2}/e2e-${randomUUID()}.jpg`, METER_JPG)
    const b = await rpc(C.pao, 'record_meter', { p_round: round2, p_room: rid, p_kind: 'elec', p_curr: 1180, p_photo_path: photo, p_ai_value: 1180 })
    expect(Number(b.elec_amount) === 640, `ค่าไฟ ${b.elec_amount}`)
    await rpc(C.pao, 'record_meter', { p_round: round2, p_room: rid, p_kind: 'water', p_curr: 18 })
    return `รวมบิล ${b.total}`
  })
  await step('AI อ่านมิเตอร์ (edge function read-meter)', async () => {
    const r = await edge('read-meter', { photo_path: uploaded[uploaded.length - 1], room_code: 'ทดสอบ101', kind: 'elec', prev: 1100 }, tokens.pao)
    if (r.status === 503) return 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY → แอปให้พิมพ์เอง (ทำงานถูก)'
    expect(r.status === 200 && 'reading' in r.body, `ผิดพลาด ${r.status} ${r.body.error}`)
    expect(r.body.reading === 1180, `AI อ่านรูปตัวอย่างได้ ${r.body.reading} (ควรเป็น 1180)`)
    return `AI อ่านได้ 1180 ถูกต้อง (มั่นใจ ${r.body.confidence}${r.body.room_label_seen ? ', ป้าย ' + r.body.room_label_seen : ''})`
  })
  await step('ยกยอดค้าง: ห้องที่ค้างรอบก่อนแสดงในบิลใหม่ · วางบิลแล้วบิลเก่าถูกล็อก', async () => {
    const nb = await bill('ทดสอบB1', round2)
    expect(Number(nb.carry_in) > 0 && nb.carry_note === label, `ยอดยกมา ${nb.carry_in} ${nb.carry_note}`)
    const rid = (await db.query(`select id from rooms where code = 'ทดสอบB1'`)).rows[0].id
    await rpc(C.pao, 'record_meter', { p_round: round2, p_room: rid, p_kind: 'elec', p_curr: 560 })
    const res = await rpc(C.nui, 'issue_round', { p_round: round2 })
    expect(res.carried_bills >= 1, 'บิลเก่าไม่ถูกยก')
    await rpcFails(C.kwang, 'record_receipt', { p_bill: (await bill('ทดสอบB1')).id, p_amount: 1, p_on_date: today() }, /ยกไปบิลรอบ|ไม่ได้ค้าง/)
    return `ยกมา ${nb.carry_in} บาท`
  })

  // ---------------------------------------------------------------- money (M2)
  const submit = (c: SupabaseClient, p: object) => rpc(c, 'submit_request', { payload: p })
  await step('ใบเบิกค่าแรง: เป้อขอ → ระบบเลือกคนอนุมัติ/จ่าย → จ่ายพร้อมรูปหลักฐาน → หน่อยตรวจ', async () => {
    const work = await upload(C.pao, `work/e2e-${randomUUID()}.jpg`)
    const r = await submit(C.pao, { type: 'daily_labor', work_date: today(), lines: [{ worker_id: W.a, project_id: 'N' }], attachments: [{ kind: 'work', path: work }] })
    const proof = await upload(C.nui, `proof/e2e-${randomUUID()}.jpg`)
    const payer = r.payer_role === 'finance' ? C.kwang : C.nui
    if (r.status === 'to_approve') await rpc(r.approver_role === 'finance' ? C.kwang : ceo, 'approve_request', { p_id: r.id })
    await rpc(payer, 'pay_request', { p_id: r.id, p_proof_paths: [proof] })
    await rpc(C.noi, 'ask_question', { p_id: r.id, p_text: 'ทดสอบ ถาม' })
    await rpc(C.pao, 'answer_question', { p_id: r.id, p_text: 'ทดสอบ ตอบ' })
    await rpc(C.noi, 'audit_request', { p_id: r.id })
    return `R${r.no}`
  })
  await step('ใบเบิกส่วนกลาง: บิลค่าน้ำประปาติดป้าย → จ่ายแล้วลงหมวดถูก · ยอดเกิน 3,000 ต้องให้กวางอนุมัติ', async () => {
    const rc1 = await upload(C.pao, `receipts/e2e-${randomUUID()}.jpg`), rc2 = await upload(C.pao, `receipts/e2e-${randomUUID()}.jpg`)
    const r = await submit(C.pao, { type: 'common', lines: [{ description: 'ทดสอบ ค่าน้ำประปา', amount: 3200, project_id: 'P', utility: 'water' },
      { description: 'ทดสอบ หลอดไฟ', amount: 80, project_id: 'SH' }], attachments: [{ kind: 'receipt', path: rc1 }, { kind: 'receipt', path: rc2 }] })
    expect(r.status === 'to_approve' && r.approver_role === 'finance', `เส้นทางผิด ${r.status}/${r.approver_role}`)
    await rpcFails(C.nui, 'pay_request', { p_id: r.id, p_proof_paths: ['x'] }, /ยังไม่ได้อนุมัติ|ไม่ได้ให้คุณ/)
    await rpc(C.kwang, 'approve_request', { p_id: r.id })
    const payer = r.payer_role === 'finance' ? C.kwang : C.nui
    await rpc(payer, 'pay_request', { p_id: r.id, p_proof_paths: [await upload(payer, `proof/e2e-${randomUUID()}.jpg`)] })
    const { data } = await C.kwang.from('ledger_entries').select('category').eq('ref_id', r.id)
    expect(data?.some((x) => x.category === 'water_utility'), 'ไม่ลงหมวดค่าน้ำประปา')
  })
  await step('เงินเดือน (ตั้งโดย CEO) · โอนระหว่างบัญชี · เจ้าของจ่ายแทน (ค่าไฟ กฟภ.) · โอนให้เจ้าของ · กระทบยอดธนาคาร', async () => {
    await rpc(ceo, 'set_salary_plan', { p_profile: created.users[1], p_monthly: 17000 })
    const s = await submit(C.pao, { type: 'salary', lines: [{ amount: 5000 }] })
    await rpc(s.approver_role === 'finance' ? C.kwang : ceo, 'approve_request', { p_id: s.id }).catch(() => undefined)
    await rpc(C.kwang, 'transfer', { p_from: 'A3', p_to: 'N', p_amount: 1000, p_note: 'ทดสอบ' })
    await rpc(C.kwang, 'record_owner_paid', { p_building: 'N', p_month: 'ทดสอบ', p_amount: 2500, p_note: 'ทดสอบ' })
    const av = await rpc(C.kwang, 'owner_draw_available')
    expect(Number(av.available) > 0, 'ไม่มีเงินให้โอนเจ้าของ')
    await rpc(ceo, 'owner_draw', { p_amount: 1000, p_note: 'ทดสอบ' })
    const { data: bal } = await C.kwang.from('wallet_balances').select('*').eq('wallet_id', 'N').single()
    const chk = await rpc(C.kwang, 'record_bank_check', { p_wallet: 'N', p_balance: Number(bal!.balance) })
    expect(Math.abs(Number(chk.diff)) < 0.01, 'กระทบยอดไม่ตรง')
  })

  // ---------------------------------------------------------------- crew (M3)
  await step('ช่างลงเวลา (เซลฟี่ + GPS) → ส่งงานพร้อมรูป → ค่าแรงขึ้นเอง · ส่งซ้ำไม่เกิดรายการซ้ำ', async () => {
    const uid = created.users[5]
    await rpc(C.w, 'accept_consent', { p_version: '1' })
    const ref = randomUUID()
    const selfie = await upload(C.w, `crew/${uid}/e2e-${randomUUID()}.jpg`)
    // the worker already has today's wage via the labour request above — so use tomorrow? No: check-in itself is fine; check-out skips duplicate wage
    const p = { client_ref: ref, project_id: 'N', work_note: 'ทดสอบ ซ่อมก๊อก', selfie_path: selfie, lat: 16.8015, lng: 100.2577, accuracy: 10, device_at: new Date().toISOString() }
    await rpc(C.w, 'check_in', { payload: p })
    const again = await rpc(C.w, 'check_in', { payload: p })
    expect(again.duplicate === true, 'ส่งซ้ำต้องไม่เกิดรายการใหม่')
    const photo = await upload(C.w, `crew/${uid}/e2e-${randomUUID()}.jpg`)
    const out = await C.w.rpc('check_out', { payload: { client_ref: randomUUID(), photos: [photo], note: 'ทดสอบ เสร็จ', lat: 16.8015, lng: 100.2577 } })
    expect(!out.error || /เบิก|มีในใบเบิก/.test(out.error.message), `ส่งงาน: ${out.error?.message}`)
    const rc = await upload(C.w, `crew/${uid}/e2e-${randomUUID()}.jpg`)
    await rpc(C.w, 'claim_material', { payload: { client_ref: randomUUID(), shop: 'ทดสอบ ร้านวัสดุ', amount: 120, project_id: 'N', receipt_path: rc } })
    const { data: mine } = await C.w.from('bills').select('id').limit(1)
    expect((mine?.length ?? 0) === 0, 'ช่างเห็นบิล')
  })
  await step('เป้อยืนยันงานวันนี้ (ยืนยันทั้งหมด) → เป็นใบเบิก', async () => {
    const r = await C.pao.rpc('confirm_claims', { p_date: today() })
    if (r.error && /ไม่มี/.test(r.error.message)) return 'ไม่มีรายการค้าง (ค่าแรงวันนี้เบิกไปแล้ว)'
    if (r.error) throw new Error(r.error.message)
    return `ใบเบิก R${(r.data as any).no ?? ''}`
  })

  // ---------------------------------------------------------------- other money + reports (M5)
  await step('รายได้อื่น/รายจ่ายอื่น: เพิ่มประเภทเอง · รายจ่ายต้องมีสลิป · เกิน 3,000 ไม่รับ · กลับรายการได้', async () => {
    const { data: k } = await C.pao.from('money_kinds').select('id').eq('direction', 'income').eq('name', 'ซักผ้า').single()
    await rpc(C.pao, 'record_other_money', { p_direction: 'income', p_kind: k!.id, p_wallet: 'PC', p_project: 'N', p_amount: 850, p_note: 'ทดสอบ' })
    const kid = await rpc<number>(C.nui, 'add_money_kind', { p_direction: 'expense', p_name: 'ทดสอบ ค่าอินเทอร์เน็ต' })
    const slip = await upload(C.nui, `other/e2e-${randomUUID()}.jpg`)
    await rpcFails(C.nui, 'record_other_money', { p_direction: 'expense', p_kind: kid, p_wallet: 'PC', p_project: 'SH', p_amount: 3500, p_photo_path: slip }, /เกิน 3,000/)
    const id = await rpc<number>(C.nui, 'record_other_money', { p_direction: 'expense', p_kind: kid, p_wallet: 'PC', p_project: 'SH', p_amount: 590, p_photo_path: slip })
    await rpc(C.kwang, 'reverse_other_money', { p_id: id, p_reason: 'ทดสอบ กลับรายการ' })
  })
  await step('รายงาน NOI รายเดือน (กวาง/หน่อยดูได้ · เป้อดูไม่ได้) + ข้อมูลสำหรับส่งออก Excel', async () => {
    const m = today().slice(0, 7)
    const rows = await rpc<any[]>(C.noi, 'noi_monthly', { p_from: m, p_to: m })
    expect(rows.length === 2, 'ต้องได้ 2 อาคาร')
    await rpcFails(C.pao, 'noi_monthly', { p_from: m, p_to: m }, /ไม่มีสิทธิ์/)
    const { error } = await C.kwang.from('bills').select('total, rooms(code), bill_rounds!inner(label)').limit(5)
    if (error) throw new Error(error.message)
    const n = rows.find((r) => r.building_id === 'N')
    return `NOI นารา (ข้อมูลทดสอบ) ${Math.round(Number(n.noi)).toLocaleString()}`
  })
  await step('แจ้งเตือน + ภาพรวม โหลดได้ (ไม่มี error)', async () => {
    for (const v of ['v_alerts', 'v_round_summary', 'wallet_balances', 'v_owner_account', 'v_requests', 'v_attendance']) {
      const { error } = await ceo.from(v).select('*').limit(1)
      if (error) throw new Error(`${v}: ${error.message}`)
    }
  })
  await step('บันทึกทุกการเปลี่ยนแปลง (audit) · รายการเงินแก้/ลบไม่ได้', async () => {
    const n = (await db.query(`select count(*)::int n from audit_log where actor is not null`)).rows[0].n
    expect(n > 20, `audit มี ${n} แถว`)
    const del = await db.query(`delete from ledger_entries where id = (select max(id) from ledger_entries)`).then(() => 'ลบได้', (e) => e.message)
    expect(del !== 'ลบได้', 'ลบรายการเงินได้ — ผิด')
  })
}

// ---------------------------------------------------------------- remove only what this run created
async function cleanup(db: pg.Client, t0: Date, snap: { settings: any[]; buildings: any[]; workers: string[]; kinds: number[]; rooms: string[]; tenants: string[] }) {
  console.log('\nลบข้อมูลทดสอบ…')
  const userTables = ['ledger_entries', 'receipts', 'audit_log', 'bills', 'bill_items', 'bill_rounds', 'meter_readings', 'deposits',
    'requests', 'request_lines', 'request_events', 'attachments', 'attendance', 'tenants', 'tenant_registrations', 'rooms', 'workers',
    'profiles', 'activation_codes', 'salary_plans', 'bank_checks', 'security_events', 'money_kinds', 'settings', 'buildings', 'login_attempts']
  const exists = (await db.query(`select tablename from pg_tables where schemaname = 'public'`)).rows.map((r) => r.tablename)
  const tables = userTables.filter((t) => exists.includes(t))
  await db.query('begin')
  try {
    for (const t of tables) await db.query(`alter table ${t} disable trigger user`)
    const del = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rowCount
    let n = 0
    // everything here was empty before the run (guarded at start), so it all belongs to the test
    for (const t of ['receipts', 'bill_items', 'meter_readings', 'request_events', 'attachments', 'ledger_entries', 'deposits', 'bank_checks',
                     'tenant_registrations', 'attendance']) if (tables.includes(t)) n += await del(`delete from ${t}`) ?? 0
    n += (await del(`update bills set carried_to = null`), 0)
    for (const t of ['bills', 'request_lines', 'requests', 'bill_rounds']) n += await del(`delete from ${t}`) ?? 0
    n += await del(`delete from tenants where not (id = any($1::uuid[]))`, [snap.tenants]) ?? 0
    n += await del(`delete from rooms where not (id = any($1::uuid[]))`, [snap.rooms]) ?? 0
    n += await del(`delete from money_kinds where not (id = any($1::int[]))`, [snap.kinds]) ?? 0
    const testProfiles = (await db.query(`select id from profiles where phone like '09900000%'`)).rows.map((r) => r.id)
    for (const t of ['activation_codes', 'salary_plans', 'security_events']) {
      if (!tables.includes(t)) continue
      const col = (await db.query(`select column_name from information_schema.columns where table_name = $1 and column_name in ('profile_id', 'subject_id', 'target_id')`, [t])).rows[0]?.column_name
      n += col ? await del(`delete from ${t} where ${col} = any($1::uuid[])`, [testProfiles]) ?? 0 : await del(`delete from ${t} where created_at >= $1`, [t0]) ?? 0
    }
    n += await del(`delete from audit_log where at >= $1`, [t0]) ?? 0
    for (const s of snap.settings) await db.query(`update settings set value = $2, updated_by = $3, updated_at = $4 where key = $1`, [s.key, s.value, s.updated_by, s.updated_at])
    n += await del(`delete from settings where not (key = any($1::text[]))`, [snap.settings.map((s) => s.key)]) ?? 0
    for (const b of snap.buildings) {
      await db.query(`update buildings set bill_name = $2, bank_name = $3, bank_account_name = $4, bank_account_no = $5, contact_phone = $6 where id = $1`,
        [b.id, b.bill_name, b.bank_name, b.bank_account_name, b.bank_account_no, b.contact_phone])
    }
    n += await del(`delete from profiles where id = any($1::uuid[])`, [testProfiles]) ?? 0
    n += await del(`delete from workers where not (id = any($1::uuid[]))`, [snap.workers]) ?? 0
    n += await del(`delete from login_attempts where phone like '09900000%'`) ?? 0
    // request numbers start again at R1 for real use
    const seq = (await db.query(`select pg_get_serial_sequence('requests', 'no') s`)).rows[0]?.s
    if (seq) await db.query(`select setval($1, 1, false)`, [seq])
    for (const t of tables) await db.query(`alter table ${t} enable trigger user`)
    await db.query('commit')
    console.log(`  ลบในฐานข้อมูล ${n} แถว`)
  } catch (e) {
    await db.query('rollback')
    console.log('  ❌ ลบไม่สำเร็จ (ยกเลิกทั้งหมด ข้อมูลเดิมไม่เปลี่ยน):', (e as Error).message)
    throw e
  }
  const ids = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => /^p09900000\d\d@dorm\.internal$/.test(u.email || '')).map((u) => u.id)
  for (const id of ids) await admin.auth.admin.deleteUser(id)
  if (uploaded.length) await admin.storage.from('photos').remove(uploaded)
  console.log(`  ลบบัญชีทดสอบ ${ids.length} · รูปทดสอบ ${uploaded.length}`)
  const left = (await db.query(`select (select count(*) from bill_rounds) + (select count(*) from ledger_entries) + (select count(*) from requests)
                                     + (select count(*) from profiles where phone like '09900000%') n`)).rows[0].n
  console.log(Number(left) === 0 ? '  ✅ ไม่เหลือข้อมูลทดสอบ' : `  ⚠ ยังเหลือ ${left} แถว`)
}

process.on('unhandledRejection', (e) => console.log('⚠ unhandled:', (e as Error)?.message))
main().catch((e) => { console.error('❌', e.message); process.exit(1) })
