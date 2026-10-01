// Other income / other expenses recorded by เป้อ and นุ้ย (owner decision 1 ต.ค. 69), kinds extendable, counted in NOI.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'

describe.skipIf(!URL)('other income / expenses', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  let M = ''
  const kind = async (dir: string, name: string) => (await su(`select id from money_kinds where direction = $1 and name = $2`, [dir, name]))[0]?.id
  const rec = (who: string, args: unknown[]) =>
    one(who, `select record_other_money($1, $2, $3, $4, $5, $6, $7, $8) id`, args).then((x) => x.id)

  beforeAll(async () => {
    users = await createUsers({ pao: ['manager', '0870000001'], nui: ['finance_field', '0870000002'], kwang: ['finance', '0870000003'],
                                noi: ['auditor', '0870000004'] })
    ;({ as, one } = makeAs(users))
    M = (await su(`select to_char(today_th(), 'YYYY-MM') m`))[0].m
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, description) values (today_th() - 40, 'PC', 1000, 'opening_balance', 't')`)
  })
  afterAll(async () => { await pool?.end() })

  it('seeded income kinds; the team adds new kinds (no duplicates by name)', async () => {
    expect(await kind('income', 'ซักผ้า')).toBeTruthy()
    const id = (await one('pao', `select add_money_kind('expense', 'ค่าอินเทอร์เน็ต') id`)).id
    expect((await one('nui', `select add_money_kind('expense', '  ค่าอินเทอร์เน็ต ') id`)).id).toBe(id)
    await expect(as('noi', `select add_money_kind('income', 'ขายของเก่า')`)).rejects.toThrow(/สิทธิ์/)
    await expect(as('pao', `select add_money_kind('income', ' ')`)).rejects.toThrow(/ใส่ชื่อประเภท/)
  })

  it('income in, expense out with a receipt photo, wallet balance guarded', async () => {
    const laundry = await kind('income', 'ซักผ้า'), net = await kind('expense', 'ค่าอินเทอร์เน็ต')
    await rec('pao', ['income', laundry, 'PC', 'N', 600, null, 'เดือนนี้', null])
    await expect(rec('nui', ['expense', net, 'PC', 'SH', 500, null, null, null])).rejects.toThrow(/ถ่ายรูปใบเสร็จ/)
    await expect(rec('nui', ['expense', net, 'PC', 'SH', 5000, null, null, 'r/x.jpg'])).rejects.toThrow(/ไม่พอ/)
    await expect(rec('nui', ['expense', laundry, 'PC', 'SH', 50, null, null, 'r/x.jpg'])).rejects.toThrow(/ไม่ใช่รายจ่าย/)
    await expect(rec('nui', ['income', laundry, 'PC', 'WAL', 50, null, null, null])).rejects.toThrow(/ใช้ใบเบิก/)
    await expect(rec('kwang', ['income', laundry, 'PC', 'N', 50, null, null, null])).rejects.toThrow(/สิทธิ์/)
    await rec('nui', ['expense', net, 'PC', 'SH', 700, null, null, 'r/net.jpg'])
    const [{ b }] = await su(`select wallet_balance('PC') b`)
    expect(Number(b)).toBe(1000 + 600 - 700)
  })

  it('a mistake is reversed with a reason (once), never edited', async () => {
    const laundry = await kind('income', 'ซักผ้า')
    const id = await rec('pao', ['income', laundry, 'PC', 'P', 999, null, 'พิมพ์ผิด', null])
    await expect(as('pao', `select reverse_other_money($1, '')`, [id])).rejects.toThrow(/เหตุผล/)
    await one('kwang', `select reverse_other_money($1, 'ใส่ยอดผิด')`, [id])
    await expect(as('pao', `select reverse_other_money($1, 'ซ้ำ')`, [id])).rejects.toThrow(/กลับไปแล้ว/)
    await expect(su(`update ledger_entries set amount = 1 where id = $1`, [id])).rejects.toThrow()
  })

  it('NOI: other income adds to revenue, other expenses to cost (shared split 32:38)', async () => {
    const rows = await as('kwang', `select * from noi_monthly($1, $1)`, [M])
    const n = rows.find((r) => r.building_id === 'N'), p = rows.find((r) => r.building_id === 'P')
    expect(Number(n.other_income)).toBe(600)
    expect(Number(p.other_income)).toBe(0)                      // 999 then reversed
    expect(Number(n.other_expense)).toBe(320)
    expect(Number(p.other_expense)).toBe(380)
    expect(Number(n.noi)).toBe(600 - 320)
    expect(Number(n.rent_profit) + Number(n.elec_margin) + Number(n.water_margin)).toBe(Number(n.noi))
  })
})
