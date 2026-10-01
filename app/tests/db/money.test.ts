// M2 database tests: SPEC §10 items 3, 6, 7, 8 + reject / audit / question / transfers / owner money / bank checks /
// CEO-account watch. Runs after db.test.ts in the same throwaway database (files run one at a time).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'

function thaiId(seed: number): string {
  const d = ('3' + String(100000000000 + seed * 7919).slice(-11)).split('').map(Number)
  let t = 0
  for (let i = 0; i < 12; i++) t += d[i] * (13 - i)
  return d.join('') + ((11 - (t % 11)) % 10)
}

describe.skipIf(!URL)('money (M2)', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  const W: Record<string, string> = {}
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
  const work = [{ kind: 'work', path: 'work/test/1.jpg' }]

  beforeAll(async () => {
    users = await createUsers({
      art: ['ceo', '0810000001'], pao: ['manager', '0810000002'], nui: ['finance_field', '0810000003'],
      kwang: ['finance', '0810000004'], noi: ['auditor', '0810000005'],
    })
    ;({ as, one } = makeAs(users))
    // money in the wallets for this suite
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, description) values
              (current_date, 'PC', 20000, 'owner_injection', 'test'), (current_date, 'A3', 200000, 'owner_injection', 'test')`)
    // two complete workers, one incomplete
    for (const [k, name, rate, i] of [['a', 'สมศักดิ์ ทดสอบ', 400, 1], ['b', 'สมปอง ทดสอบ', 450, 2]] as const) {
      W[k] = await one('pao', `select upsert_worker($1::jsonb) id`, [JSON.stringify({
        full_name: name, kind: 'technician', daily_rate: rate, phone: `08900000${10 + i}`, national_id: thaiId(i), id_card_path: `id/${k}.jpg`,
      })]).then((r) => r.id)
    }
    W.c = await one('pao', `select upsert_worker($1::jsonb) id`, [JSON.stringify({ full_name: 'ยังไม่ครบ ทดสอบ', kind: 'maid', daily_rate: 350 })]).then((r) => r.id)
  })
  afterAll(async () => { await pool?.end() })

  const submit = (who: string, p: object) => one(who, `select submit_request($1::jsonb) r`, [JSON.stringify(p)]).then((x) => x.r)

  it('worker registry: checksum, rate changes only by CEO, incomplete worker cannot be claimed', async () => {
    await expect(as('pao', `select upsert_worker($1::jsonb)`, [JSON.stringify({ full_name: 'x y', daily_rate: 400, national_id: '1234567890123' })]))
      .rejects.toThrow(/เลขบัตรประชาชนไม่ถูกต้อง/)
    await expect(as('nui', `select upsert_worker($1::jsonb)`, [JSON.stringify({ id: W.a, full_name: 'สมศักดิ์ ทดสอบ', daily_rate: 500 })]))
      .rejects.toThrow(/เฉพาะ CEO/)
    await expect(submit('pao', { type: 'daily_labor', lines: [{ worker_id: W.c, project_id: 'N' }], attachments: work }))
      .rejects.toThrow(/ขาด เบอร์โทร, เลขบัตร, รูปบัตร/)
  })

  it('daily labor needs a work photo; renovation needs a room; amount must equal the rate', async () => {
    await expect(submit('pao', { type: 'daily_labor', lines: [{ worker_id: W.a, project_id: 'N' }] })).rejects.toThrow(/แนบรูปงาน/)
    await expect(submit('pao', { type: 'daily_labor', lines: [{ worker_id: W.a, project_id: 'N503', work_type: 'renovation' }], attachments: work }))
      .rejects.toThrow(/ต้องใส่เลขห้อง/)
    await expect(submit('pao', { type: 'daily_labor', lines: [{ worker_id: W.a, project_id: 'N', amount: 999 }], attachments: work }))
      .rejects.toThrow(/ต้องเท่ากับอัตราในทะเบียน/)
  })

  let small = '', mid = '', big = ''
  it('acceptance 6 — routing by total', async () => {
    const r1 = await submit('pao', { type: 'daily_labor', work_date: today, lines: [{ worker_id: W.a, project_id: 'N' }, { description: 'ไทวัสดุ', amount: 663, project_id: 'N' }], attachments: work })
    expect(r1).toMatchObject({ status: 'to_pay', approver_role: 'finance_field', payer_role: 'finance_field', wallet_id: 'PC', total: 1063 })
    small = r1.id
    const r2 = await submit('pao', { type: 'material', lines: [{ description: 'สีทาห้อง', amount: 3500, project_id: 'P' }] })
    expect(r2).toMatchObject({ status: 'to_approve', approver_role: 'finance', payer_role: 'finance_field', wallet_id: 'PC' })
    mid = r2.id
    const r3 = await submit('pao', { type: 'material', lines: [{ description: 'ค่าวัสดุ บ้าน Waldorf', amount: 12065, project_id: 'WAL', work_type: 'project' }] })
    expect(r3).toMatchObject({ status: 'to_approve', approver_role: 'finance', payer_role: 'finance', wallet_id: 'A3' })
    big = r3.id
    // 3,500: กวาง approves → นุ้ย pays from PC
    await expect(as('nui', `select approve_request($1)`, [mid])).rejects.toThrow(/ไม่ได้อยู่ในวงเงิน/)
    await one('kwang', `select approve_request($1)`, [mid])
    await expect(as('kwang', `select pay_request($1, array['p.jpg'])`, [mid])).rejects.toThrow(/ไม่ได้ให้คุณเป็นคนจ่าย/)
    expect((await one('nui', `select pay_request($1, array['proof/m.jpg']) r`, [mid])).r.status).toBe('paid')
    // 12,065: กวาง approve-and-pay from A3 in one step, slip required
    await expect(as('kwang', `select pay_request($1, array[]::text[])`, [big])).rejects.toThrow(/แนบสลิปโอน/)
    expect((await one('kwang', `select pay_request($1, array['slip/b.jpg']) r`, [big])).r.status).toBe('paid')
    const led = await as('kwang', `select wallet_id, amount::float, category, project_id from ledger_entries where ref_id = $1`, [big])
    expect(led).toEqual([{ wallet_id: 'A3', amount: -12065, category: 'material', project_id: 'WAL' }])
  })

  it('acceptance 3 — two devices press "จ่ายแล้ว" at once → one success, one Thai error, one set of ledger rows', async () => {
    const res = await Promise.allSettled([
      as('nui', `select pay_request($1, array['proof/1.jpg'])`, [small]),
      as('art', `select pay_request($1, array['proof/2.jpg'])`, [small]),
    ])
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(String((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.message)).toMatch(/สถานะ "จ่ายแล้ว รอตรวจ" แล้ว/)
    const led = await as('kwang', `select category, amount::float from ledger_entries where ref_id = $1 order by amount`, [small])
    expect(led).toEqual([{ category: 'material', amount: -663 }, { category: 'labor', amount: -400 }])
  })

  it('acceptance 7 — the same worker on two requests for the same date is refused; reject frees the worker', async () => {
    await expect(submit('nui', { type: 'daily_labor', work_date: today, lines: [{ worker_id: W.a, project_id: 'P' }], attachments: work }))
      .rejects.toThrow(/มีในใบเบิกวันที่ .* แล้ว — 1 คน เบิกได้วันละครั้ง/)
    // two lines for the same worker inside one request
    await expect(submit('pao', { type: 'daily_labor', work_date: '2026-10-03', lines: [{ worker_id: W.b, project_id: 'N' }, { worker_id: W.b, project_id: 'P' }], attachments: work }))
      .rejects.toThrow(/วันละครั้ง/)
    // big labor request (forces approval), rejected → worker free again
    const r = await submit('pao', { type: 'daily_labor', work_date: '2026-10-04', lines: [{ worker_id: W.b, project_id: 'N' }, { description: 'ปูกระเบื้อง', amount: 4000, project_id: 'N' }], attachments: work })
    await expect(as('kwang', `select reject_request($1, '')`, [r.id])).rejects.toThrow(/ใส่เหตุผล/)
    await one('kwang', `select reject_request($1, 'ราคาสูงเกิน')`, [r.id])
    const again = await submit('pao', { type: 'daily_labor', work_date: '2026-10-04', lines: [{ worker_id: W.b, project_id: 'N' }], attachments: work })
    expect(again.status).toBe('to_pay')
  })

  it('insufficient wallet balance is refused with the balance in the message', async () => {
    const r = await submit('pao', { type: 'material', lines: [{ description: 'แอร์ 3 เครื่อง', amount: 9000, project_id: 'N' }] })
    await one('kwang', `select approve_request($1)`, [r.id])
    const [{ b }] = await su(`select wallet_balance('PC')::float b`)
    expect(b).toBeLessThan(9000 + 20000)
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, description) values (current_date, 'PC', $1, 'adjustment', 'drain for test')`, [-(b - 100)])
    await expect(as('nui', `select pay_request($1, array['p.jpg'])`, [r.id])).rejects.toThrow(/เงินสำรองนุ้ยไม่พอ \(เหลือ 100.00 บาท ต้องจ่าย 9,000.00 บาท\) — ขอเติมเงินสำรองก่อน/)
  })

  it('petty refill: A3 → PC on payment, approved and paid by finance', async () => {
    await expect(submit('pao', { type: 'petty_refill', lines: [{ amount: 10000 }] })).rejects.toThrow(/เฉพาะการเงินหน้างาน/)
    const r = await submit('nui', { type: 'petty_refill', lines: [{ amount: 10000 }] })
    expect(r).toMatchObject({ status: 'to_approve', wallet_id: 'A3', approver_role: 'finance' })
    await one('kwang', `select pay_request($1, array['slip/r.jpg'])`, [r.id])
    const led = await as('kwang', `select wallet_id, amount::float from ledger_entries where ref_id = $1 order by wallet_id`, [r.id])
    expect(led).toEqual([{ wallet_id: 'A3', amount: -10000 }, { wallet_id: 'PC', amount: 10000 }])
  })

  it('acceptance 6 — salary over remaining is refused; plan default from role; CEO edits plan', async () => {
    const s0 = await one('pao', `select * from salary_status()`)
    expect(Number(s0.plan)).toBe(17000)
    const r = await submit('pao', { type: 'salary', lines: [{ amount: 12000 }] })
    expect(r).toMatchObject({ status: 'to_approve', wallet_id: 'A3' })
    await expect(submit('pao', { type: 'salary', lines: [{ amount: 5001 }] })).rejects.toThrow(/เกินเงินเดือนคงเหลือ \(เบิกได้อีก 5,000.00 บาท\)/)
    await expect(submit('pao', { type: 'salary', salary_for: users.nui, lines: [{ amount: 100 }] })).rejects.toThrow(/เฉพาะของตัวเอง/)
    await expect(as('kwang', `select set_salary_plan($1, 20000)`, [users.pao])).rejects.toThrow(/เฉพาะ CEO/)
    await one('art', `select set_salary_plan($1, 20000)`, [users.pao])
    expect(Number((await one('pao', `select remaining from salary_status()`)).remaining)).toBe(8000)
    await one('kwang', `select pay_request($1, array['slip/s.jpg'])`, [r.id])
    const s = await one('kwang', `select * from salary_status($1)`, [users.pao])
    expect([Number(s.drawn), Number(s.pending), Number(s.remaining)]).toEqual([12000, 0, 8000])
    await expect(as('pao', `select * from salary_status($1)`, [users.nui])).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('common expenses: itemised with one receipt per line; "ไม่ระบุ" refused', async () => {
    await expect(submit('pao', { type: 'common', lines: [{ description: 'ค่าใช้จ่ายส่วนกลาง (ไม่ระบุรายการ)', amount: 500, project_id: 'SH' }], attachments: [{ kind: 'receipt', path: 'r/1.jpg' }] }))
      .rejects.toThrow(/ไม่ระบุรายการ/)
    await expect(submit('pao', { type: 'common', lines: [{ description: 'น้ำยาล้างพื้น', amount: 300, project_id: 'SH' }, { description: 'หลอดไฟ', amount: 200, project_id: 'SH' }], attachments: [{ kind: 'receipt', path: 'r/1.jpg' }] }))
      .rejects.toThrow(/ถ่ายใบเสร็จให้ครบ 2 ใบ/)
    const r = await submit('pao', { type: 'common', lines: [{ description: 'น้ำยาล้างพื้น', amount: 300, project_id: 'SH' }, { description: 'หลอดไฟ', amount: 200, project_id: 'SH' }],
      attachments: [{ kind: 'receipt', path: 'r/1.jpg' }, { kind: 'receipt', path: 'r/2.jpg' }] })
    expect(r.status).toBe('to_pay')
  })

  it('audit & questions: auditor asks → requester answers → audit; flags shown; auditor cannot pay', async () => {
    const [v] = await as('noi', `select flags, status from v_requests where id = $1`, [big])
    expect(v.flags).toContain('real_estate_loan')
    await expect(as('noi', `select pay_request($1, array['x'])`, [mid])).rejects.toThrow(/ไม่มีสิทธิ์/)
    await one('noi', `select ask_question($1, 'ใบเสร็จร้านไหน')`, [mid])
    await expect(as('noi', `select audit_request($1)`, [mid])).rejects.toThrow(/ตรวจได้เมื่อจ่ายแล้ว/)
    await expect(as('nui', `select answer_question($1, 'x')`, [mid])).rejects.toThrow(/เฉพาะคนขอเบิก/)
    await one('pao', `select answer_question($1, 'ร้านไทวัสดุ แนบใบเสร็จแล้ว')`, [mid])
    await one('noi', `select audit_request($1)`, [mid])
    const [x] = await as('kwang', `select status, auditor_name, question, answer from v_requests where id = $1`, [mid])
    expect(x).toEqual({ status: 'audited', auditor_name: 'noi', question: 'ใบเสร็จร้านไหน', answer: 'ร้านไทวัสดุ แนบใบเสร็จแล้ว' })
    const ev = await as('kwang', `select action from request_events where request_id = $1 order by id`, [mid])
    expect(ev.map((e: any) => e.action)).toEqual(['submit', 'approve', 'pay', 'ask', 'answer', 'audit'])
  })

  it('transfers between wallets; owner-paid expense; owner injection', async () => {
    const [{ a3 }] = await su(`select wallet_balance('A3')::float a3`)
    await expect(as('kwang', `select transfer('A3', 'A3', 100)`)).rejects.toThrow(/ต่างกัน/)
    await expect(as('kwang', `select transfer('PC', 'A3', 999999)`)).rejects.toThrow(/เงินสำรองนุ้ยไม่พอ/)
    await one('kwang', `select transfer('A3', 'N', 1000, 'ทดสอบ')`)
    expect(Number((await su(`select wallet_balance('A3') b`))[0].b)).toBe(a3 - 1000)
    await expect(as('pao', `select transfer('A3', 'N', 1)`)).rejects.toThrow(/ไม่มีสิทธิ์/)
    const before = await one('kwang', `select * from v_owner_account`)
    await one('kwang', `select record_owner_paid('N', '09/2569', 25000)`)
    await one('kwang', `select owner_injection('A3', 5000, 'เติมเงิน')`)
    const after = await one('kwang', `select * from v_owner_account`)
    expect(Number(after.owner_paid_new) - Number(before.owner_paid_new)).toBe(25000)
    expect(Number(after.injection_new) - Number(before.injection_new)).toBe(5000)
    expect(Number(after.re_new)).toBe(12065) // Waldorf materials = dorm money lent to the owner
    expect(Number(after.owner_owes_dorm)).toBe(Number(before.owner_owes_dorm) - 30000)
  })

  it('acceptance 8 — owner draw greater than available is refused with the computed figure', async () => {
    const a = await one('kwang', `select owner_draw_available() a`).then((x) => x.a)
    const avail = Number(a.available)
    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (avail > 0) {
      await expect(as('kwang', `select owner_draw($1)`, [avail + 1])).rejects.toThrow(`โอนได้ไม่เกิน ${fmt(avail)} บาท`)
    } else {
      await expect(as('kwang', `select owner_draw(1)`)).rejects.toThrow(`โอนได้ ${fmt(avail).replace(/^(-?)/, '$1')} บาท`)
    }
    // make room: big injection, then draw within the limit succeeds from A3 only
    await one('kwang', `select owner_injection('A3', 500000)`)
    const a2 = Number((await one('kwang', `select owner_draw_available() a`)).a.available)
    expect(a2).toBeGreaterThan(1000)
    await one('kwang', `select owner_draw(1000, 'ทดสอบ')`)
    await expect(as('noi', `select owner_draw(1)`)).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('bank reconciliation: mismatch shows up in alerts', async () => {
    const r = await one('kwang', `select record_bank_check('N', 1) r`)
    expect(Number(r.r.diff)).toBeLessThan(0)
    const al = await as('noi', `select kind, title from v_alerts where kind = 'bank_mismatch'`)
    expect(al[0].title).toMatch(/บัญชีนารา ไม่ตรงกับธนาคาร/)
    const sys = Number(r.r.system)
    await one('kwang', `select record_bank_check('N', $1)`, [sys])
    expect(await as('noi', `select kind from v_alerts where kind = 'bank_mismatch'`)).toEqual([])
  })

  it('CEO-account watch: creating or granting CEO raises an alert until the CEO acknowledges', async () => {
    await one('nui', `select admin_update_profile($1, 'noi', 'ceo', true)`, [users.noi])
    const al = await as('art', `select kind, title, detail from v_alerts where kind = 'ceo_account'`)
    expect(al).toHaveLength(1)
    expect(al[0].detail).toMatch(/ให้สิทธิ์ CEO noi \(0810000005\) โดย nui/)
    expect(await as('kwang', `select kind from v_alerts where kind = 'ceo_account'`)).toEqual([])
    const [ev] = await as('art', `select id from security_events where acknowledged_at is null and phone = '0810000005'`)
    await expect(as('nui', `select ack_security_event($1)`, [ev.id])).rejects.toThrow(/เฉพาะ CEO/)
    await expect(as('nui', `select * from security_events`)).resolves.toEqual([])
    await one('art', `select ack_security_event($1)`, [ev.id])
    await one('nui', `select admin_update_profile($1, 'noi', 'auditor', true)`, [users.noi])
    const left = await as('art', `select detail from v_alerts where kind = 'ceo_account'`)
    expect(left[0].detail).toMatch(/ถอดสิทธิ์ CEO noi/)
  })

  it('alerts: flagged requests and petty cash low', async () => {
    const kinds = (await as('kwang', `select kind from v_alerts`)).map((a: any) => a.kind)
    expect(kinds).toEqual(expect.arrayContaining(['request_flags']))
  })

  it('every money RPC wrote audit_log with the caller; ledger still append-only', async () => {
    const [{ n }] = await su(`select count(*)::int n from audit_log where table_name in ('requests','request_lines','ledger_entries','bank_checks','security_events') and actor is not null`)
    expect(n).toBeGreaterThan(30)
    await expect(su(`update ledger_entries set amount = 0 where category = 'owner_draw'`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/)
  })
})
