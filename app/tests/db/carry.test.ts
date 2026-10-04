// Unpaid balances move to the next bill (owner decision 1 ต.ค. 69): shown while the round is a draft, fixed on issue,
// old bill frozen as 'carried' so the money is owed in one place only.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'

const room = (code: string, status: string, rent: number) => ({ code, building: 'N', status, base_rent: rent })
const rooms = [room('Y201', 'occupied', 3000), room('Y202', 'occupied', 2500), room('Y203', 'vacant', 2500)]
const pay = (label: string, extra: Record<string, unknown> = {}) => ({
  settings: { label, meter_month: label, issue_date: '2026-09-01', due_date: '2026-09-05' },
  rooms, meters: [], items: [], carry: [], workers: [], ...extra,
})

describe.skipIf(!URL)('carry-forward of unpaid balances', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  const R: Record<string, string> = {}
  const bill = async (round: string, code: string) =>
    (await su(`select * from bills where round_id = $1 and room_id = $2`, [round, R[code]]))[0]
  let A = '', B = ''

  beforeAll(async () => {
    users = await createUsers({ pao: ['manager', '0850000001'], nui: ['finance_field', '0850000002'], kwang: ['finance', '0850000003'] })
    ;({ as, one } = makeAs(users))
    const p = pay('A', {
      meters: [{ code: 'Y201', elec_prev: 100, elec_curr: 150 }, { code: 'Y202', elec_prev: 100, elec_curr: 110 }],
      items: [{ code: 'Y203', description: 'ค่าซ่อมประตู', amount: 500 }],
    })
    A = (await one('pao', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r.round_id
    await one('nui', `select issue_round($1)`, [A])
    for (const x of await su(`select id, code from rooms`)) R[x.code] = x.id
    const y202 = await bill(A, 'Y202')
    await one('kwang', `select record_receipt($1, 2000, '2026-09-03')`, [y202.id])
  })
  afterAll(async () => { await pool?.end() })

  it('draft round shows each room\'s arrears with the round it came from', async () => {
    expect(Number((await bill(A, 'Y201')).total)).toBe(3400)
    const r = (await one('pao', `select start_round('B', 'A', null, '2026-10-05') r`)).r
    B = r.round_id
    expect(r.carried_rooms).toBe(3)
    const y201 = await bill(B, 'Y201')
    expect(Number(y201.carry_in)).toBe(3400)
    expect(y201.carry_note).toBe('A')
    expect(Number((await bill(B, 'Y202')).carry_in)).toBe(580)
    const y203 = await bill(B, 'Y203')
    expect(Number(y203.carry_in)).toBe(500)
    expect(y203.status).toBe('open')          // vacant room that still owes = receivable
  })

  it('a payment made while the round is a draft is taken off on issue; old bills become carried', async () => {
    await one('kwang', `select record_receipt($1, 580, '2026-10-02')`, [(await bill(A, 'Y202')).id])
    await one('pao', `select record_meter($1, $2, 'elec', 200)`, [B, R.Y201])
    await one('pao', `select record_meter($1, $2, 'elec', 120)`, [B, R.Y202])
    const res = (await one('nui', `select issue_round($1) r`, [B])).r
    expect(res.carried_bills).toBe(2)
    expect(Number((await bill(B, 'Y202')).carry_in)).toBe(0)
    const nb = await bill(B, 'Y201')
    expect(Number(nb.total)).toBe(3000 + 50 * 8 + 3400)
    const ob = await bill(A, 'Y201')
    expect(ob.status).toBe('carried')
    expect(ob.carried_to).toBe(nb.id)
    expect((await bill(A, 'Y202')).status).toBe('closed')
  })

  it('the old bill is frozen; paying the new bill clears everything', async () => {
    const ob = await bill(A, 'Y201'), nb = await bill(B, 'Y201')
    await expect(as('kwang', `select record_receipt($1, 100, '2026-10-06')`, [ob.id])).rejects.toThrow(/ยกไปบิลรอบ B แล้ว|ไม่ได้ค้างชำระ/)
    await expect(as('kwang', `select add_bill_item($1, 'ส่วนลด', -100, 'ทดสอบ')`, [ob.id])).rejects.toThrow(/ยกไปบิลรอบ B แล้ว/)
    await expect(as('pao', `select add_penalty($1, 100)`, [ob.id])).rejects.toThrow()
    const r = (await one('kwang', `select record_receipt($1, $2, '2026-10-06') r`, [nb.id, nb.total])).r
    expect(r.status).toBe('closed')
    const [sA] = await su(`select sum(carried_rooms)::int n, sum(carried_out) amt, sum(outstanding) o from v_round_summary where round_id = $1`, [A])
    expect(sA.n).toBe(2)                       // Y201 + Y203
    expect(Number(sA.amt)).toBe(3900)
    expect(Number(sA.o)).toBe(0)
  })

  it('Excel carry for a room the system already carries → warned on import, refused on issue', async () => {
    const p = pay('C', { meters: [{ code: 'Y201', elec_prev: 200, elec_curr: 210 }, { code: 'Y202', elec_prev: 120, elec_curr: 130 }],
                         carry: [{ code: 'Y202', amount: 999 }] })
    const r = (await one('pao', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r
    expect(JSON.stringify(r.warnings)).toMatch(/Y202.*มียอดค้างในระบบอยู่แล้ว/)
    await expect(as('nui', `select issue_round($1)`, [r.round_id])).rejects.toThrow(/Y202 มียอดค้างยกมาจาก Excel และยอดค้างในระบบซ้ำกัน/)
  })
})
