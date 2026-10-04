// M4 database tests: จดมิเตอร์ในแอป — start a round from the last one, record each meter, bill recomputed at once,
// same §4.6 flags as the import, Excel re-import keeps readings taken on the phone.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'

const room = (code: string, status: string, rent: number, extra: Record<string, unknown> = {}) =>
  ({ code, building: 'N', status, base_rent: rent, ...extra })

function payload(label: string, meters: Record<string, unknown>[]) {
  return {
    settings: { label, meter_month: label, issue_date: '2026-09-01', due_date: '2026-09-05' },
    rooms: [
      room('X101', 'occupied', 4000, { tenant_name: 'ผู้เช่าทดสอบ' }),
      room('X102', 'occupied', 3500, { water_flat: 150 }),
      room('X103', 'vacant', 3500),
      room('X104', 'staff', 3000, { elec_rate_override: 4.5, water_flat: 150 }),
      room('เช่าที่จอดรถX', 'occupied', 1000),
    ],
    meters, items: [], carry: [], workers: [],
  }
}

describe.skipIf(!URL)('meters (M4)', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  const R: Record<string, string> = {}
  let round = ''
  const rec = (who: string, code: string, kind: string, curr: number, extra = 'null, null, null') =>
    one(who, `select record_meter($1, $2, $3, $4, ${extra}) r`, [round, R[code], kind, curr]).then((x) => x.r)

  beforeAll(async () => {
    users = await createUsers({ pao: ['manager', '0840000001'], nui: ['finance_field', '0840000002'],
                                kwang: ['finance', '0840000003'], noi: ['auditor', '0840000004'], w: ['worker', '0840000005'] })
    ;({ as, one } = makeAs(users))
    const p = payload('T-ก.ย. 69', [
      { code: 'X101', elec_prev: 1000, elec_curr: 1100, water_prev: 10, water_curr: 12 },
      { code: 'X102', elec_prev: 500, elec_curr: 520 },
      { code: 'X103', elec_prev: 200, elec_curr: 200 },
      { code: 'X104', elec_prev: 300, elec_curr: 350 },
    ])
    const r = (await one('pao', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r
    await one('nui', `select issue_round($1)`, [r.round_id])
    // everyone paid round 1, so these tests are about meters only (carry-forward has its own file)
    await su(`update bills set paid = total, status = 'closed' where round_id = $1 and status = 'open'`, [r.round_id])
    for (const x of await su(`select id, code from rooms`)) R[x.code] = x.id
  })
  afterAll(async () => { await pool?.end() })

  it('start_round: new draft from the last round, prev filled in, parking has no meter', async () => {
    await expect(as('kwang', `select start_round('T-ต.ค. 69', 'ก.ย. 69', '2026-10-01', '2026-10-05')`)).rejects.toThrow(/สิทธิ์/)
    const r = (await one('pao', `select start_round('T-ต.ค. 69', 'ก.ย. 69', '2026-10-01', '2026-10-05') r`)).r
    round = r.round_id
    expect(r.rooms).toBe(5)
    await expect(as('nui', `select start_round('T-พ.ย. 69', null, null, '2026-11-05')`)).rejects.toThrow(/T-ต.ค. 69 ที่ยังไม่วางบิล/)

    const sheet = await as('pao', `select * from meter_sheet($1)`, [round])
    expect(sheet.map((s) => s.code)).toEqual(['X101', 'X102', 'X103', 'X104'])
    const x101 = sheet.find((s) => s.code === 'X101')
    expect(Number(x101.elec_prev)).toBe(1100)
    expect(Number(x101.prev_units)).toBe(100)
    expect(Number(x101.water_prev)).toBe(12)
    expect(x101.tenant_name).toBe('ผู้เช่าทดสอบ')
    expect(x101.flags).toContain('missing_elec')
    expect(await as('w', `select * from meter_sheet($1)`, [round])).toEqual([])
    await expect(as('pao', `select issue_round($1)`, [round])).rejects.toThrow(/ยังไม่จดไฟ: X101, X102/)
  })

  it('record_meter: bill recomputed at once (rent + units × rate + water)', async () => {
    let b = await rec('pao', 'X101', 'elec', 1180, `'meters/t/x101.jpg', 1180, null`)
    expect(Number(b.elec_units)).toBe(80)
    expect(Number(b.elec_amount)).toBe(640)
    expect(b.flags).toEqual(['missing_water'])
    b = await rec('nui', 'X101', 'water', 15)
    expect(Number(b.water_amount)).toBe(90)
    expect(Number(b.total)).toBe(4000 + 640 + 90)
    expect(b.flags).toEqual([])
    const [m] = await su(`select ai_value, photo_path, read_by_name, via from meter_readings where round_id = $1 and room_id = $2 and kind = 'elec'`, [round, R.X101])
    expect(m).toMatchObject({ photo_path: 'meters/t/x101.jpg', read_by_name: 'pao', via: 'app' })
    expect(Number(m.ai_value)).toBe(1180)
  })

  it('same flags as §4.6: over 2× last month, decreased, vacant with use', async () => {
    expect((await rec('pao', 'X102', 'elec', 570)).flags).toEqual(['over_2x_last_month'])   // 50 units vs 20
    const staff = await rec('pao', 'X104', 'elec', 340)
    expect(staff.flags).toEqual(['elec_decreased'])
    expect(Number(staff.elec_amount)).toBe(0)
    expect(staff.status).toBe('welfare')
    const ok = await rec('pao', 'X104', 'elec', 360)   // typed again correctly: 10 units × 4.50
    expect(Number(ok.elec_amount)).toBe(45)
    expect(ok.flags).toEqual([])
    const vac = await rec('pao', 'X103', 'elec', 205)
    expect(vac.flags).toEqual(['vacant_has_use'])
    expect(vac.status).toBe('vacant')
    expect(Number(vac.total)).toBe(0)
  })

  it('guards: roles, negative numbers, prev cannot be changed here, photo path, no-meter rooms', async () => {
    await expect(rec('kwang', 'X102', 'elec', 600)).rejects.toThrow(/สิทธิ์/)
    await expect(rec('noi', 'X102', 'elec', 600)).rejects.toThrow(/สิทธิ์/)
    await expect(rec('w', 'X102', 'elec', 600)).rejects.toThrow(/สิทธิ์/)
    await expect(rec('pao', 'X102', 'elec', -1)).rejects.toThrow(/0 ขึ้นไป/)
    await expect(rec('pao', 'X102', 'elec', 600, `null, null, 400`)).rejects.toThrow(/เลขครั้งก่อนคือ 520/)
    await expect(rec('pao', 'X102', 'elec', 600, `'crew/x.jpg', null, null`)).rejects.toThrow(/ที่เก็บรูป/)
    await expect(rec('pao', 'เช่าที่จอดรถX', 'elec', 1)).rejects.toThrow(/ไม่มีมิเตอร์/)
  })

  it('two phones save the same room at the same moment → one reading row, bill matches it', async () => {
    const results = await Promise.allSettled([rec('pao', 'X102', 'elec', 530), rec('nui', 'X102', 'elec', 531)])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const rows = await su(`select curr from meter_readings where round_id = $1 and room_id = $2 and kind = 'elec'`, [round, R.X102])
    expect(rows).toHaveLength(1)
    const [b] = await su(`select elec_curr, elec_units from bills where round_id = $1 and room_id = $2`, [round, R.X102])
    expect(Number(b.elec_curr)).toBe(Number(rows[0].curr))
    expect(Number(b.elec_units)).toBe(Number(rows[0].curr) - 520)
  })

  it('issue after all occupied rooms are read; no edits after issue', async () => {
    const done = (await one('nui', `select issue_round($1) r`, [round])).r
    expect(done.open_bills).toBeGreaterThanOrEqual(2)
    await expect(rec('pao', 'X101', 'elec', 1190)).rejects.toThrow(/วางบิลแล้ว/)
  })

  it('re-importing the Excel keeps readings taken on the phone (sheet numbers win where typed)', async () => {
    const r = (await one('pao', `select start_round('T-พ.ย. 69', 'ต.ค. 69', null, '2026-11-05') r`)).r
    round = r.round_id
    await rec('pao', 'X101', 'elec', 1250, `'meters/t/x101b.jpg', 1250, null`)
    await rec('pao', 'X102', 'elec', 600)
    const p = payload('T-พ.ย. 69', [
      { code: 'X101', elec_prev: 1180 },                         // empty "this time" cell → phone reading kept
      { code: 'X102', elec_prev: 531, elec_curr: 610 },          // typed in the sheet → sheet wins
      { code: 'X104', elec_prev: 360, elec_curr: 370 },
    ])
    p.settings.due_date = '2026-11-05'
    const res = (await one('pao', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r
    expect(res.kept_app_readings).toBe(1)
    expect(res.blocking).toEqual([])
    const bills = await su(`select ro.code, b.elec_curr, b.elec_amount from bills b join rooms ro on ro.id = b.room_id
                            where b.round_id = $1 order by ro.code`, [res.round_id])
    const by = Object.fromEntries(bills.map((b) => [b.code, b]))
    expect(Number(by.X101.elec_curr)).toBe(1250)
    expect(Number(by.X101.elec_amount)).toBe(70 * 8)
    expect(Number(by.X102.elec_curr)).toBe(610)
    const [m] = await su(`select photo_path from meter_readings where round_id = $1 and room_id = $2 and kind = 'elec'`, [res.round_id, R.X101])
    expect(m.photo_path).toBe('meters/t/x101b.jpg')
  })
})
