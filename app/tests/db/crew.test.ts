// M3 database tests: SPEC §10 items 9, 9a, 9b, 9c + material claims, confirm / reject, worker privacy.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'

function thaiId(seed: number): string {
  const d = ('5' + String(100000000000 + seed * 104729).slice(-11)).split('').map(Number)
  let t = 0
  for (let i = 0; i < 12; i++) t += d[i] * (13 - i)
  return d.join('') + ((11 - (t % 11)) % 10)
}

// นารา แมนชั่น is at 16.801452, 100.2576706
const AT_NARA = { lat: 16.80150, lng: 100.25770, accuracy: 12 }
const FIVE_KM_AWAY = { lat: 16.84650, lng: 100.25770, accuracy: 15 }

describe.skipIf(!URL)('crew (M3)', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  const W: string[] = []

  beforeAll(async () => {
    const spec: Record<string, ['manager' | 'finance_field' | 'finance' | 'auditor' | 'worker', string]> = {
      pao: ['manager', '0820000001'], nui: ['finance_field', '0820000002'], kwang: ['finance', '0820000003'], noi: ['auditor', '0820000004'],
    }
    for (let i = 1; i <= 7; i++) spec[`w${i}`] = ['worker', `08300000${10 + i}`]
    users = await createUsers(spec)
    ;({ as, one } = makeAs(users))
    for (let i = 1; i <= 7; i++) {
      const [{ id }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path)
                                 values ($1, 'technician', $2, $3, $4, 'id/x.jpg') returning id`,
                                [`ช่างทดสอบ${i}`, 400 + (i % 2) * 50, `08300000${10 + i}`, thaiId(i)])
      W.push(id)
      await su(`update profiles set worker_id = $1, consent_at = now() where id = $2`, [id, users[`w${i}`]])
    }
    await su(`update workers set is_team_lead = true where id = $1`, [W[5]])  // w6 leads w7 + others
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, description) values (current_date, 'PC', 50000, 'owner_injection', 't')`)
  })
  afterAll(async () => { await pool?.end() })

  const checkIn = (who: string, extra: object = {}, pos: object = AT_NARA) =>
    one(who, `select check_in($1::jsonb) r`, [JSON.stringify({ client_ref: randomUUID(), project_id: 'N', work_note: 'ซ่อมก๊อกห้อง 304', selfie_path: `crew/${users[who]}/s.jpg`, device_at: new Date().toISOString(), ...pos, ...extra })]).then((x) => x.r)
  const checkOut = (who: string, extra: object = {}) =>
    one(who, `select check_out($1::jsonb) r`, [JSON.stringify({ client_ref: randomUUID(), photos: [`crew/${users[who]}/w1.jpg`], note: 'เปลี่ยนก๊อกเสร็จ', ...AT_NARA, ...extra })]).then((x) => x.r)

  it('check-in needs a selfie and a work note; check-out needs photos; no check-out without check-in', async () => {
    await expect(as('w1', `select check_in($1::jsonb)`, [JSON.stringify({ project_id: 'N', work_note: 'x' })])).rejects.toThrow(/ถ่ายเซลฟี่/)
    await expect(as('w1', `select check_in($1::jsonb)`, [JSON.stringify({ project_id: 'N', selfie_path: 's.jpg' })])).rejects.toThrow(/วันนี้ทำงานอะไร/)
    await expect(checkOut('w1')).rejects.toThrow(/ยังไม่ได้ลงเวลาเข้าวันนี้/)
    await expect(as('kwang', `select check_in($1::jsonb)`, [JSON.stringify({ project_id: 'N', work_note: 'x', selfie_path: 's' })])).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('acceptance 9a — five workers check in and out within the same minute, all at once', async () => {
    const who = ['w1', 'w2', 'w3', 'w4', 'w5']
    const ins = await Promise.allSettled(who.map((w) => checkIn(w)))
    expect(ins.filter((r) => r.status === 'fulfilled')).toHaveLength(5)
    const outs = await Promise.allSettled(who.map((w) => checkOut(w, { photos: [`crew/${users[w]}/a.jpg`, `crew/${users[w]}/b.jpg`] })))
    expect(outs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
    const [{ a }] = await su(`select count(*)::int a from attendance where work_date = today_th() and checkout_at is not null`)
    const [{ c }] = await su(`select count(*)::int c from request_lines where status = 'claimed' and work_date = today_th() and worker_id is not null`)
    expect([a, c]).toEqual([5, 5])
    // เป้อ's "ยืนยันงานวันนี้" sees all five
    const pending = await as('pao', `select rl.id from request_lines rl where status = 'claimed' and work_date = today_th()`)
    expect(pending).toHaveLength(5)
    // a second check-in the same day is refused
    await expect(checkIn('w1')).rejects.toThrow(/ลงเวลาวันนี้ไปแล้ว/)
    await expect(checkOut('w1')).rejects.toThrow(/ส่งงานวันนี้ไปแล้ว/)
  })

  it('acceptance 9 — check-in 5 km from the building is saved with a flag and shows in alerts', async () => {
    const r = await checkIn('w7', {}, FIVE_KM_AWAY)
    expect(r.done).toEqual(['ช่างทดสอบ7'])
    expect(r.distance_m).toBeGreaterThan(4900)
    const [v] = await as('noi', `select flags, distance_m from v_attendance where worker_id = $1`, [W[6]])
    expect(v.flags).toContain('far')
    const al = await as('noi', `select title, detail from v_alerts where kind = 'checkin_gps'`)
    expect(al[0].detail).toMatch(/ช่างทดสอบ7 .* \(ห่าง \d+ ม\.\)/)
    // no GPS at all → flag too
    await su(`delete from attendance where worker_id = $1`, [W[6]])
    const r2 = await checkIn('w7', {}, { lat: null, lng: null })
    expect(r2.has_gps).toBe(false)
    expect((await one('noi', `select flags from v_attendance where worker_id = $1`, [W[6]])).flags).toContain('no_gps')
  })

  it('acceptance 9b — lead submits a team of 4 while one member already checked in alone → 3 rows, 1 skipped', async () => {
    // w7 already checked in (previous test). Lead w6 submits for w7 + two workers without phones (W[0..1] already in → use fresh ones)
    const [{ id: x1 }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path) values ('ลูกทีม ก', 'technician', 350, '0840000001', $1, 'i') returning id`, [thaiId(91)])
    const [{ id: x2 }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path) values ('ลูกทีม ข', 'technician', 350, '0840000002', $1, 'i') returning id`, [thaiId(92)])
    await expect(checkIn('w7', { member_ids: [x1] })).rejects.toThrow(/เฉพาะหัวหน้าทีม/)
    const r = await checkIn('w6', { member_ids: [W[6], x1, x2], selfie_path: `crew/${users.w6}/group.jpg` })
    expect(r.done.sort()).toEqual(['ช่างทดสอบ6', 'ลูกทีม ก', 'ลูกทีม ข'].sort())
    expect(r.skipped).toEqual([{ name: 'ช่างทดสอบ7', message: 'ช่างทดสอบ7 ลงเวลาวันนี้เองแล้ว — ข้าม' }])
    const rows = await as('pao', `select full_name, lead_name, flags from v_attendance where by_lead is not null order by full_name`)
    expect(rows.map((x: any) => [x.full_name, x.lead_name])).toEqual([['ลูกทีม ก', 'ช่างทดสอบ6'], ['ลูกทีม ข', 'ช่างทดสอบ6']])
    // w7 checks out alone first → his wage claim exists; the lead's team check-out must not claim him again
    await checkOut('w7')
    const out = await checkOut('w6', { member_ids: [W[6], x1, x2] })
    expect(out.done.sort()).toEqual(['ช่างทดสอบ6', 'ลูกทีม ก', 'ลูกทีม ข'].sort())
    expect(out.skipped).toEqual([{ name: 'ช่างทดสอบ7', message: 'ช่างทดสอบ7 ส่งงานไปแล้ว — ข้าม' }])
    const [{ n }] = await su(`select count(*)::int n from request_lines where worker_id = $1 and work_date = today_th()`, [W[6]])
    expect(n).toBe(1)
  })

  it('acceptance 9c — the offline queue resending the same item does not duplicate it', async () => {
    const [{ id: x3 }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path) values ('ช่างออฟไลน์', 'technician', 400, '0840000003', $1, 'i') returning id`, [thaiId(93)])
    const [u] = await su(`insert into auth.users (email) values ('p0840000003@dorm.internal') returning id`)
    await su(`insert into profiles (id, display_name, phone, role, worker_id) values ($1, 'off', '0840000003', 'worker', $2)`, [u.id, x3])
    users.off = u.id
    const inRef = randomUUID(), outRef = randomUUID()
    const payloadIn = JSON.stringify({ client_ref: inRef, project_id: 'P', work_note: 'ทาสี', selfie_path: 's', ...AT_NARA })
    const payloadOut = JSON.stringify({ client_ref: outRef, photos: ['p1'], note: 'ทาสีเสร็จ' })
    await one('off', `select check_in($1::jsonb)`, [payloadIn])
    expect((await one('off', `select check_in($1::jsonb) r`, [payloadIn])).r.duplicate).toBe(true)
    // the same check-out sent twice at the same moment (reconnect race)
    await Promise.allSettled([one('off', `select check_out($1::jsonb)`, [payloadOut]), one('off', `select check_out($1::jsonb)`, [payloadOut])])
    expect((await one('off', `select check_out($1::jsonb) r`, [payloadOut])).r.duplicate).toBe(true)
    const [{ a, c }] = await su(`select (select count(*)::int from attendance where worker_id = $1) a,
                                        (select count(*)::int from request_lines where worker_id = $1) c`, [x3])
    expect([a, c]).toEqual([1, 1])
    const matRef = randomUUID()
    const mat = JSON.stringify({ client_ref: matRef, shop: 'ไทวัสดุ สีน้ำ', amount: 480, project_id: 'P', receipt_path: 'r.jpg' })
    const m1 = await one('off', `select claim_material($1::jsonb) r`, [mat])
    const m2 = await one('off', `select claim_material($1::jsonb) r`, [mat])
    expect(m2.r).toEqual({ id: m1.r.id, duplicate: true })
  })

  it('material claim needs a receipt photo; workers see only their own data', async () => {
    await expect(as('w1', `select claim_material($1::jsonb)`, [JSON.stringify({ shop: 'x', amount: 10, project_id: 'N' })])).rejects.toThrow(/ใบเสร็จ/)
    const att = await as('w1', `select worker_id from attendance`)
    expect(att.every((r: any) => r.worker_id === W[0])).toBe(true)
    expect(await as('w1', `select * from v_attendance where worker_id <> $1`, [W[0]])).toEqual([])
    expect(await as('w1', `select * from requests`)).toEqual([])
    const mine = await as('w1', `select line_status from my_claims()`)
    expect(mine).toEqual([{ line_status: 'claimed' }])
  })

  it('9a (cont.) — confirm-all creates the request(s) with correct routing; reject frees nothing twice', async () => {
    const pend = await as('pao', `select id, amount::float, worker_id from request_lines where status = 'claimed' and work_date = today_th() order by created_at`)
    // reject one line with a reason
    const victim = pend.find((l: any) => l.worker_id === W[4])
    await expect(as('pao', `select reject_claim($1, '')`, [victim.id])).rejects.toThrow(/เหตุผล/)
    await one('pao', `select reject_claim($1, 'วันนี้ไม่ได้มาทำงาน')`, [victim.id])
    const total = pend.filter((l: any) => l.id !== victim.id).reduce((s: number, l: any) => s + l.amount, 0)
    const res = await Promise.allSettled([
      one('pao', `select confirm_claims(today_th()) r`),
      one('nui', `select confirm_claims(today_th()) r`),
    ])
    const ok = res.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    expect(ok).toHaveLength(1)
    const r = ok[0].value.r
    expect(Number(r.total)).toBe(total)
    expect(total).toBeGreaterThan(3000)
    expect(r).toMatchObject({ status: 'to_approve', approver_role: 'finance', payer_role: total > 10000 ? 'finance' : 'finance_field' })
    const att = await as('kwang', `select kind, count(*)::int n from attachments where owner_id = $1 group by kind order by kind`, [r.id])
    expect(att.find((a: any) => a.kind === 'work').n).toBeGreaterThanOrEqual(5)
    expect(att.find((a: any) => a.kind === 'receipt').n).toBe(1)
    // labor lines with a check-in are not flagged "no_checkin"
    const [v] = await as('kwang', `select flags from v_requests where id = $1`, [r.id])
    expect(v.flags).not.toContain('no_checkin')
    // the worker now sees "รอจ่าย" (request to_approve) for his line
    const mine = await as('w1', `select line_status, request_status, request_no from my_claims()`)
    expect(mine[0]).toMatchObject({ line_status: 'in_request', request_status: 'to_approve', request_no: r.no })
    const [rej] = await as('w5', `select line_status, reject_note from my_claims()`)
    expect(rej).toEqual({ line_status: 'rejected', reject_note: 'วันนี้ไม่ได้มาทำงาน' })
  })

  it('manager checks in on behalf of a worker without a phone (flag on_behalf)', async () => {
    const [{ id: x4 }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path) values ('ไม่มีมือถือ', 'maid', 350, '0840000004', $1, 'i') returning id`, [thaiId(94)])
    await one('pao', `select check_in($1::jsonb)`, [JSON.stringify({ worker_id: x4, project_id: 'P', work_note: 'ทำความสะอาด', selfie_path: 's', lat: null })])
    const [v] = await as('noi', `select flags, on_behalf_name from v_attendance where worker_id = $1`, [x4])
    expect(v.flags).toEqual(expect.arrayContaining(['on_behalf', 'no_gps']))
    expect(v.on_behalf_name).toBe('pao')
  })

  it('manual labor request for a worker without a check-in is flagged no_checkin', async () => {
    const [{ id: x5 }] = await su(`insert into workers (full_name, kind, daily_rate, phone, national_id, id_card_path) values ('ไม่ลงเวลา', 'technician', 400, '0840000005', $1, 'i') returning id`, [thaiId(95)])
    const r = await one('pao', `select submit_request($1::jsonb) r`, [JSON.stringify({ type: 'daily_labor', lines: [{ worker_id: x5, project_id: 'N' }], attachments: [{ kind: 'work', path: 'w' }] })])
    const [v] = await as('kwang', `select flags from v_requests where id = $1`, [r.r.id])
    expect(v.flags).toContain('no_checkin')
  })
})
