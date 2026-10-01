// M5: monthly NOI per building (same method as reference/NOI-dashboard.html) + utility tagging on common requests.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { URL, pool, su, makeAs, createUsers, type Users } from './helpers'
import { parseNoiDashboard } from '../../../scripts/noi-history'

describe.skipIf(!URL)('reports (M5)', () => {
  let users: Users
  let as: ReturnType<typeof makeAs>['as'], one: ReturnType<typeof makeAs>['one']
  let M = ''   // this month, YYYY-MM (payments are dated today by the RPCs)
  const N = (r: any, k: string) => Number(r[k])

  beforeAll(async () => {
    users = await createUsers({ art: ['ceo', '0860000001'], pao: ['manager', '0860000002'], nui: ['finance_field', '0860000003'],
                                kwang: ['finance', '0860000004'], noi: ['auditor', '0860000005'] })
    ;({ as, one } = makeAs(users))
    M = (await su(`select to_char(today_th(), 'YYYY-MM') m`))[0].m
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, description)
              select today_th() - 40, id, 100000, 'opening_balance', 'ทดสอบ' from wallets where not is_virtual`)
    const p = {
      settings: { label: 'R-' + M, meter_month: M, issue_date: `${M}-01`, due_date: `${M}-05` },
      rooms: [{ code: 'Z1', building: 'N', status: 'occupied', base_rent: 4000 },
              { code: 'Z2', building: 'P', status: 'occupied', base_rent: 3000, water_flat: 150 }],
      meters: [{ code: 'Z1', elec_prev: 100, elec_curr: 200, water_prev: 10, water_curr: 15 }, { code: 'Z2', elec_prev: 50, elec_curr: 60 }],
      items: [], carry: [], workers: [],
    }
    const r = (await one('pao', `select import_round($1::jsonb) r`, [JSON.stringify(p)])).r
    await one('nui', `select issue_round($1)`, [r.round_id])
    const b = await su(`select b.id, ro.code, b.total from bills b join rooms ro on ro.id = b.room_id where b.round_id = $1`, [r.round_id])
    const z1 = b.find((x) => x.code === 'Z1'), z2 = b.find((x) => x.code === 'Z2')
    expect(Number(z1.total)).toBe(4000 + 800 + 150)
    await one('kwang', `select record_receipt($1, $2, today_th())`, [z1.id, z1.total])
    await one('kwang', `select record_receipt($1, 3000, today_th())`, [z2.id])        // Z2 pays part of 3,230
    await one('kwang', `select record_owner_paid('N', $1, 400, null)`, [M])           // PEA bill paid by the owner
    await su(`insert into ledger_entries (on_date, wallet_id, amount, category, project_id, description) values
              (today_th(), 'A3', -1000, 'labor', 'N', 'ช่าง'),
              (today_th(), 'A3', -700, 'common', 'SH', 'ส่วนกลาง'),
              (today_th(), 'A3', -7000, 'salary', 'SH', 'เงินเดือน'),
              (today_th(), 'A3', -2000, 'material', 'N503', 'ห้อง 503'),
              (today_th(), 'A3', -5000, 'material', 'WAL', 'Waldorf'),
              (today_th(), 'N', 3000, 'deposit', 'N', 'ประกัน')`)
  })
  afterAll(async () => { await pool?.end() })

  it('a waterworks bill is tagged on a common request and lands as water_utility when paid', async () => {
    await expect(as('pao', `select submit_request($1::jsonb)`, [JSON.stringify({ type: 'common', lines: [
      { description: 'ค่าน้ำประปา', amount: 120, project_id: 'SH', utility: 'water' }], attachments: [{ kind: 'receipt', path: 'r/1.jpg' }] })]))
      .rejects.toThrow(/ต้องเลือกอาคาร/)
    await expect(as('pao', `select submit_request($1::jsonb)`, [JSON.stringify({ type: 'material', lines: [
      { description: 'ท่อ', amount: 120, project_id: 'P', utility: 'water' }] })])).rejects.toThrow(/เฉพาะค่าใช้จ่ายส่วนกลาง/)
    const r = (await one('pao', `select submit_request($1::jsonb) r`, [JSON.stringify({ type: 'common', lines: [
      { description: 'ค่าน้ำประปา ปรายดาว', amount: 120, project_id: 'P', utility: 'water' },
      { description: 'หลอดไฟทางเดิน', amount: 80, project_id: 'P' }],
      attachments: [{ kind: 'receipt', path: 'r/1.jpg' }, { kind: 'receipt', path: 'r/2.jpg' }] })])).r
    await one('art', `select pay_request($1, array['p/1.jpg'])`, [r.id])
    const cats = await su(`select category, amount from ledger_entries where ref_id = $1 order by amount`, [r.id])
    expect(cats.map((c) => [c.category, Number(c.amount)])).toEqual([['water_utility', -120], ['common', -80]])
  })

  it('NOI per building: rent profit / electricity margin / water margin, shared costs split 32:38', async () => {
    await expect(as('pao', `select * from noi_monthly($1, $1)`, [M])).rejects.toThrow(/สิทธิ์/)
    expect((await as('noi', `select * from noi_monthly($1, $1)`, [M])).length).toBe(2)
    const rows = await as('kwang', `select * from noi_monthly($1, $1)`, [M])
    const n = rows.find((r) => r.building_id === 'N'), p = rows.find((r) => r.building_id === 'P')
    // นารา: received 4,950 · billed elec 800 water 150 · PEA 400 · ops 1,000 + 32/70 × 7,700 = 4,520
    expect(n.source).toBe('ledger')
    expect([N(n, 'revenue'), N(n, 'elec_billed'), N(n, 'water_billed'), N(n, 'elec_cost'), N(n, 'water_cost'), N(n, 'op_cost')])
      .toEqual([4950, 800, 150, 400, 0, 4520])
    expect([N(n, 'elec_margin'), N(n, 'water_margin'), N(n, 'rent_profit'), N(n, 'noi')]).toEqual([400, 150, -520, 30])
    expect([N(n, 'capex'), N(n, 'deposits_net')]).toEqual([2000, 3000])     // shown apart, not in NOI
    // ปรายดาว: received 3,000 · billed elec 80 water 150 (flat) · waterworks 120 · ops 80 + 38/70 × 7,700 = 4,260
    expect([N(p, 'revenue'), N(p, 'elec_margin'), N(p, 'water_margin'), N(p, 'op_cost'), N(p, 'noi')]).toEqual([3000, 80, 30, 4260, -1380])
    expect(N(p, 'rent_profit') + N(p, 'elec_margin') + N(p, 'water_margin')).toBe(N(p, 'noi'))
  })

  it('real Jan–Sep history (only when /reference is loaded) adds up to the owner dashboard', async () => {
    const dash = resolve(__dirname, '../../../reference/NOI-dashboard.html')
    const [{ c }] = await su(`select count(*)::int c from noi_history where month like '2026-%'`)
    if (c === 0 || !existsSync(dash)) return
    const want = parseNoiDashboard(readFileSync(dash, 'utf8'))
    const rows = await as('kwang', `select building_id, sum(noi) noi, sum(elec_margin) e, sum(water_margin) w from noi_monthly('2026-01', '2026-09') group by 1 order by 1`)
    for (const r of rows) {
      const mine = want.filter((x) => x.building_id === r.building_id)
      expect(N(r, 'noi')).toBeCloseTo(mine.reduce((s, x) => s + x.revenue - x.cost, 0), 1)
      expect(N(r, 'e')).toBe(mine.reduce((s, x) => s + x.elec_margin, 0))
      expect(N(r, 'w')).toBe(mine.reduce((s, x) => s + x.water_margin, 0))
    }
  })

  it('months before go-live come from the owner\'s dashboard history; split ratio is a setting', async () => {
    await su(`insert into noi_history (month, building_id, revenue, cost, elec_margin, water_margin) values ('2025-01', 'N', 100000, 40000.5, 7000, 1500)`)
    const [h] = await as('kwang', `select * from noi_monthly('2025-01', '2025-01') where building_id = 'N'`)
    expect(h.source).toBe('history')
    expect(N(h, 'noi')).toBeCloseTo(59999.5, 2)
    expect(N(h, 'rent_profit')).toBeCloseTo(59999.5 - 7000 - 1500, 2)
    await expect(su(`update noi_history set revenue = 0`)).rejects.toThrow()
    await expect(as('kwang', `select update_setting('shared_split', '{"N": 0, "P": 38}')`)).rejects.toThrow(/มากกว่า 0/)
    await one('kwang', `select update_setting('shared_split', '{"N": 1, "P": 1}')`)
    const rows = await as('kwang', `select * from noi_monthly($1, $1)`, [M])
    expect(N(rows.find((r) => r.building_id === 'N'), 'op_cost')).toBe(1000 + 3850)
  })
})
