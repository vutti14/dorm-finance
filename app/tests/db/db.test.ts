// Database tests against a real Postgres with all migrations applied (run via scripts/test-db.sh).
// Covers SPEC §10 items 1 (server side), 4, 5, 10, plus concurrency (item 3 pattern) on receipts.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseWorkbook, type RoundPayload } from '../../src/lib/importer'
import { computeRound } from '../../src/lib/billing'

const URL = process.env.DATABASE_URL
const REF = process.env.REFERENCE_DIR || resolve(__dirname, '../../../reference')
const SAMPLE = resolve(REF, 'test_import_sample.xlsx')

type Role = 'ceo' | 'manager' | 'finance_field' | 'finance' | 'auditor' | 'worker'
const pool = URL ? new pg.Pool({ connectionString: URL, max: 8 }) : (null as unknown as pg.Pool)
const users: Record<Role, string> = {} as Record<Role, string>

/** run one statement as a logged-in user (role authenticated + JWT sub), in its own transaction */
async function as<T = any>(who: Role | 'anon', sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    if (who === 'anon') {
      await c.query(`set local role anon`)
    } else {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: users[who], role: 'authenticated' })])
      await c.query(`set local role authenticated`)
    }
    const r = await c.query(sql, params)
    await c.query('commit')
    return r.rows as T[]
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}
const one = async <T = any>(who: Role | 'anon', sql: string, params: unknown[] = []) => (await as<T>(who, sql, params))[0]
const su = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows

function samplePayload(): RoundPayload {
  const { payload, errors } = parseWorkbook(readFileSync(SAMPLE))
  if (!payload) throw new Error(errors.join('\n'))
  return payload
}

describe.skipIf(!URL || !existsSync(SAMPLE))('database', () => {
  beforeAll(async () => {
    const phones: Record<Role, string> = {
      ceo: '0800000001', manager: '0800000002', finance_field: '0800000003',
      finance: '0800000004', auditor: '0800000005', worker: '0800000006',
    }
    for (const role of Object.keys(phones) as Role[]) {
      const id = randomUUID()
      users[role] = id
      await su(`insert into auth.users (id, email) values ($1, $2)`, [id, `p${phones[role]}@dorm.internal`])
      await su(`insert into profiles (id, display_name, phone, role) values ($1, $2, $3, $4)`, [id, role, phones[role], role])
    }
    const [w] = await su(`select id from workers where full_name = 'ช่างอ้น'`)
    await su(`update workers set national_id = '1101700230708' where id = $1`, [w.id])
    await su(`update profiles set worker_id = $1 where id = $2`, [w.id, users.worker])
  })
  afterAll(async () => { await pool?.end() })

  let roundId = ''

  it('acceptance 1 — server import totals equal the workbook and the client preview', async () => {
    const p = samplePayload()
    const res = await one('finance_field', `select import_round($1::jsonb) r`, [JSON.stringify(p)])
    const r = res.r
    const preview = computeRound(p)
    roundId = r.round_id
    expect(r.totals).toMatchObject({ N: 197635, P: 207180, all: 404815, rent: 271500, elec: 77815, water: 11400, service: 1720, items: 1300, carry: 41080 })
    for (const k of Object.keys(preview.totals) as (keyof typeof preview.totals)[]) expect([k, Number(r.totals[k])]).toEqual([k, preview.totals[k]])
    expect(r.blocking).toEqual(['B206'])
    expect(r.warnings.map((w: any) => w.room)).toEqual(['B5-H (ออฟฟิตเก่า)'])

    const bills = await as('finance', `select ro.code, b.total::float, b.status, b.flags from bills b join rooms ro on ro.id = b.room_id where b.round_id = $1`, [roundId])
    const by = Object.fromEntries(bills.map((b: any) => [b.code, b]))
    expect(by['302'].total).toBe(15850)
    expect(by['207']).toMatchObject({ total: 10791, status: 'welfare' })
    expect(by['B207'].flags).toContain('elec_decreased')
    expect(bills.filter((b: any) => b.flags.includes('vacant_has_use')).map((b: any) => b.code).sort())
      .toEqual(['105', '106', '309', '501', '503', '888VIP'].sort())
    // every bill matches the client preview
    for (const pb of preview.bills) expect([pb.code, by[pb.code].total, by[pb.code].status]).toEqual([pb.code, pb.total, pb.status])
  })

  it('opening deposits are recorded once, workers merged by name when phones are shared', async () => {
    const [d] = await as('finance', `select sum(held)::float s from v_deposits_held`)
    expect(d.s).toBe(6400 + 4600 + 6500 + 5200 + 7000 + 4000 + 8000)
    const w = await as('finance', `select full_name, phone from v_workers order by full_name`)
    expect(w).toHaveLength(5)
    const shared = w.filter((x: any) => x.phone && w.filter((y: any) => y.phone === x.phone).length > 1)
    expect(shared.map((x: any) => x.full_name).sort()).toEqual(['ช่างเต้', 'ช่างแม็ค'])
  })

  it('issue is blocked by missing elec readings, then re-import replaces the draft', async () => {
    await expect(as('finance_field', `select issue_round($1)`, [roundId])).rejects.toThrow(/ยังไม่จดไฟ: B206/)
    const p = samplePayload()
    const m = p.meters.find((x) => x.code === 'B206')!
    Object.assign(m, { elec_prev: 1000, elec_curr: 1100, water_prev: 10, water_curr: 12 })
    // acceptance 4 setup: B201 owes exactly its carry-in of 5,438 (vacant room, nothing else billed)
    p.rooms.find((x) => x.code === 'B201')!.status = 'vacant'
    const r = (await one('manager', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r
    expect(r.blocking).toEqual([])
    const [{ n }] = await su(`select count(*)::int n from bill_rounds where label = 'ต.ค. 69'`)
    expect(n).toBe(1)
    roundId = r.round_id
    const done = (await one('finance_field', `select issue_round($1) r`, [roundId])).r
    expect(done.open_bills).toBeGreaterThan(50)
  })

  it('re-import after issue is refused', async () => {
    await expect(as('finance_field', `select import_round($1::jsonb)`, [JSON.stringify(samplePayload())]))
      .rejects.toThrow(/วางบิลแล้ว นำเข้าซ้ำไม่ได้/)
  })

  it('staff room posts a non-cash pair (NOI unchanged)', async () => {
    const rows = await as('finance', `select category, amount::float from ledger_entries where wallet_id = 'NONCASH' order by amount desc`)
    expect(rows).toEqual([{ category: 'staff_room', amount: 10791 }, { category: 'welfare_housing', amount: -10791 }])
  })

  it('acceptance 4 — partial receipts on B201 (5,438), overpay refused', async () => {
    const [b] = await as('finance', `select b.id, b.total::float from bills b join rooms ro on ro.id = b.room_id where ro.code = 'B201' and b.round_id = $1`, [roundId])
    expect(b.total).toBe(5438)
    const [w0] = await as('finance', `select coalesce(sum(amount), 0)::float balance from ledger_entries where wallet_id = 'P'`)
    const r1 = (await one('finance', `select record_receipt($1, 3000, '2026-10-05') r`, [b.id])).r
    expect(r1).toMatchObject({ status: 'open', remaining: 2438 })
    await expect(as('finance', `select record_receipt($1, 2500, '2026-10-06')`, [b.id])).rejects.toThrow(/รับเกินยอดค้าง \(ค้าง 2,438.00 บาท\)/)
    const r2 = (await one('finance', `select record_receipt($1, 2438, '2026-10-06') r`, [b.id])).r
    expect(r2).toMatchObject({ status: 'closed', remaining: 0 })
    await expect(as('finance', `select record_receipt($1, 1, '2026-10-06')`, [b.id])).rejects.toThrow(/ปิดรอบนี้แล้ว/)
    const [w] = await as('finance', `select coalesce(sum(amount), 0)::float balance from ledger_entries where wallet_id = 'P'`)
    expect(w.balance).toBe(w0.balance + 5438)
  })

  it('two people tick "received" on the same bill at the same moment → exactly one succeeds', async () => {
    const [b] = await as('finance', `select b.id, b.total::float t from bills b join rooms ro on ro.id = b.room_id where ro.code = '100' and b.round_id = $1`, [roundId])
    const results = await Promise.allSettled([
      as('finance', `select record_receipt($1, $2, '2026-10-05')`, [b.id, b.t]),
      as('ceo', `select record_receipt($1, $2, '2026-10-05')`, [b.id, b.t]),
    ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(String(failed.reason.message)).toMatch(/ปิดรอบนี้แล้ว/)
    const [{ n }] = await su(`select count(*)::int n from receipts r join bills b on b.id = r.bill_id where b.id = $1`, [b.id])
    expect(n).toBe(1)
  })

  it('penalty: only after issue, capped at the round maximum', async () => {
    const [b] = await as('finance', `select b.id from bills b join rooms ro on ro.id = b.room_id where ro.code = '302' and b.round_id = $1`, [roundId])
    await one('finance_field', `select add_penalty($1, 3000)`, [b.id])
    await expect(as('finance_field', `select add_penalty($1, 200)`, [b.id])).rejects.toThrow(/เกินเพดาน 3,100/)
    await expect(as('finance', `select add_penalty($1, 100)`, [b.id])).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('adjustment after issue needs a reason', async () => {
    const [b] = await as('finance', `select b.id from bills b join rooms ro on ro.id = b.room_id where ro.code = '303' and b.round_id = $1`, [roundId])
    await expect(as('finance', `select add_bill_item($1, 'ส่วนลดน้ำรั่ว', -100, '')`, [b.id])).rejects.toThrow(/ต้องใส่เหตุผล/)
    await one('finance', `select add_bill_item($1, 'ส่วนลดน้ำรั่ว', -100, 'ท่อรั่วจากฝั่งหอ')`, [b.id])
    const [x] = await as('finance', `select total::float, items_total::float from bills where id = $1`, [b.id])
    expect(x).toEqual({ total: 4876 - 100, items_total: -100 })
  })

  it('deposits: money in to the building wallet; refund cannot exceed what is held', async () => {
    await one('finance', `select record_deposit('B101', 'deposit', 3000, '2026-10-03')`)
    await expect(as('finance', `select record_deposit('B101', 'refund', 3500, '2026-10-04')`)).rejects.toThrow(/คืนเกินไม่ได้/)
    const r = (await one('finance', `select record_deposit('B101', 'refund', 1000, '2026-10-04') r`)).r
    expect(Number(r.held)).toBe(2000)
  })

  it('acceptance 5 — RLS: a worker sees no bills, ledger or other workers; auditor cannot write', async () => {
    expect(await as('worker', `select * from bills`)).toEqual([])
    expect(await as('worker', `select * from ledger_entries`)).toEqual([])
    expect(await as('worker', `select * from rooms`)).toEqual([])
    const ws = await as('worker', `select full_name, national_id from v_workers`)
    expect(ws).toEqual([{ full_name: 'ช่างอ้น', national_id: 'x-xxxx-xxxxx-70-8' }])
    await expect(as('worker', `select national_id from workers`)).rejects.toThrow(/permission denied/)
    await expect(as('finance_field', `select national_id from workers`)).rejects.toThrow(/permission denied/)
    // masked for finance_field, full for finance / ceo
    const mask = await as('finance_field', `select national_id from v_workers where national_id is not null`)
    expect(mask).toEqual([{ national_id: 'x-xxxx-xxxxx-70-8' }])
    const full = await as('finance', `select national_id from v_workers where national_id is not null`)
    expect(full).toEqual([{ national_id: '1101700230708' }])

    for (const sql of [
      `insert into ledger_entries (on_date, wallet_id, amount, category) values (current_date, 'A3', 1, 'adjustment')`,
      `update bills set paid = 0`,
      `delete from bills`,
    ]) {
      for (const who of ['auditor', 'finance', 'ceo', 'worker'] as const) {
        await expect(as(who, sql), `${who}: ${sql}`).rejects.toThrow(/permission denied/)
      }
    }
    await expect(as('auditor', `select import_round('{}'::jsonb)`)).rejects.toThrow(/ไม่มีสิทธิ์/)
    const [b] = await as('auditor', `select id from bills where status = 'open' limit 1`)
    await expect(as('auditor', `select record_receipt($1, 1, current_date)`, [b.id])).rejects.toThrow(/ไม่มีสิทธิ์/)
    await expect(as('anon', `select * from bills`)).rejects.toThrow(/permission denied/)
  })

  it('acceptance 10 — RPCs write audit_log; ledger rows cannot be deleted by anyone', async () => {
    const [{ n }] = await su(`select count(*)::int n from audit_log where table_name in ('receipts','bills','ledger_entries','bill_rounds','deposits','bill_items')`)
    expect(n).toBeGreaterThan(100)
    const [a] = await su(`select actor from audit_log where table_name = 'receipts' limit 1`)
    expect(a.actor).toBe(users.finance)
    await expect(su(`delete from ledger_entries`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/)
    await expect(su(`update ledger_entries set amount = 0`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/)
    await expect(su(`truncate ledger_entries cascade`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/)
    await expect(su(`delete from audit_log`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/)
  })

  it('tenant registration: public form → pending → approve → appears as active tenant', async () => {
    const [ro] = await su(`select id, reg_token from rooms where code = '305'`)
    const info = (await one('anon', `select registration_room($1) r`, [ro.reg_token])).r
    expect(info).toMatchObject({ room: '305', building: 'นารา แมนชั่น', has_pending: false })
    expect(JSON.stringify(info)).not.toMatch(/tenant|phone/)
    const form = { name: 'สมชาย ใจดี', phone: '081-234-5678', line_id: 'somchai', emergency_name: 'แม่', emergency_phone: '0899999999', accepted: true }
    await one('anon', `select submit_tenant_registration($1, $2::jsonb)`, [ro.reg_token, JSON.stringify(form)])
    await expect(as('anon', `select submit_tenant_registration($1, $2::jsonb)`, [ro.reg_token, JSON.stringify(form)])).rejects.toThrow(/รอเจ้าหน้าที่ตรวจ/)
    await expect(as('anon', `select submit_tenant_registration('nope', $1::jsonb)`, [JSON.stringify(form)])).rejects.toThrow(/ลิงก์ไม่ถูกต้อง/)
    await expect(as('anon', `select * from tenant_registrations`)).rejects.toThrow(/permission denied/)
    const [reg] = await as('finance_field', `select id from tenant_registrations where status = 'pending'`)
    await one('finance_field', `select decide_tenant_registration($1, true)`, [reg.id])
    const [t] = await as('finance', `select name, phone, source from tenants where room_id = $1 and active`, [ro.id])
    expect(t).toEqual({ name: 'สมชาย ใจดี', phone: '0812345678', source: 'registration' })
  })

  it('alerts: overdue rent per building, vacant rooms, meter flags, workers', async () => {
    const al = await as('auditor', `select level, kind, title from v_alerts`)
    const kinds = al.map((a: any) => a.kind)
    expect(kinds).toEqual(expect.arrayContaining(['overdue_rent', 'vacant', 'meter', 'worker_registry', 'duplicate_phone']))
    expect(await as('worker', `select * from v_alerts`)).toEqual([])
  })

  it('realtime publication covers the live tables', async () => {
    const rows = await su(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)
    expect(rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(
      ['bills', 'receipts', 'bill_rounds', 'meter_readings', 'requests', 'request_events', 'attendance', 'ledger_entries', 'workers']))
  })

  it('petty cash opening balance: set, then corrected with a reason via an adjustment entry', async () => {
    expect(Number((await one('finance', `select set_opening_balance('PC', 10000) r`)).r)).toBe(10000)
    await expect(as('finance', `select set_opening_balance('PC', 9500)`)).rejects.toThrow(/ต้องใส่เหตุผล/)
    await one('finance', `select set_opening_balance('PC', 9500, 'นับใหม่ ขาด 500')`)
    const rows = await as('finance', `select category, amount::float from ledger_entries where wallet_id = 'PC' order by id`)
    expect(rows).toEqual([{ category: 'opening_balance', amount: 10000 }, { category: 'adjustment', amount: -500 }])
    expect(Number((await one('finance', `select pc_opening_amount() r`)).r)).toBe(9500)
    await expect(as('finance_field', `select set_opening_balance('PC', 1, 'x')`)).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('users: manager and finance_field manage every account; finance cannot touch CEO accounts', async () => {
    await one('manager', `select admin_update_profile($1, 'auditor', 'finance', true)`, [users.auditor])
    await one('finance_field', `select admin_update_profile($1, 'auditor', 'auditor', true)`, [users.auditor])
    await one('finance_field', `select admin_update_profile($1, 'w', 'ceo', true)`, [users.worker])
    await expect(as('finance', `select admin_update_profile($1, 'w', 'worker', true)`, [users.worker])).rejects.toThrow(/CEO/)
    await one('manager', `select admin_update_profile($1, 'w', 'worker', true)`, [users.worker])
    await expect(as('manager', `select admin_update_profile($1, 'm', 'worker', true)`, [users.manager])).rejects.toThrow(/ของตัวเอง/)
    await expect(as('auditor', `select admin_update_profile($1, 'w', 'worker', true)`, [users.worker])).rejects.toThrow(/ไม่มีสิทธิ์/)
  })
})
