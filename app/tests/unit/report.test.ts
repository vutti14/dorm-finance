// M5: NOI rollup on the client + the Jan–Sep history parser (the latter only when /reference is present).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { monthTh, rollup, type NoiRow } from '../../src/views/ReportView'
import { parseNoiDashboard } from '../../../scripts/noi-history'

const row = (month: string, b: 'N' | 'P', rent: number, elec: number, water: number, source: NoiRow['source'] = 'ledger'): NoiRow => ({
  month, building_id: b, source, revenue: rent + elec + water + 100, other_income: null, other_expense: null, elec_billed: null, water_billed: null, elec_cost: null,
  water_cost: null, op_cost: null, rent_profit: rent, elec_margin: elec, water_margin: water, noi: rent + elec + water, capex: 0, deposits_net: 0,
})

describe('NOI rollup', () => {
  const rows = [row('2026-09', 'N', 100, 10, 1, 'history'), row('2026-09', 'P', 200, 20, 2, 'history'), row('2026-10', 'N', 300, 30, 3), row('2026-10', 'P', -50, 5, 0)]
  it('sums both buildings per month and in total', () => {
    const r = rollup(rows, 'all')
    expect(r.byMonth.map((m) => [m.month, m.source, m.noi])).toEqual([['2026-09', 'history', 333], ['2026-10', 'ledger', 288]])
    expect(r.total).toMatchObject({ rent: 550, elec: 65, water: 6, noi: 621 })
  })
  it('one building only', () => {
    expect(rollup(rows, 'P').total.noi).toBe(177)
  })
  it('Thai month label', () => {
    expect(monthTh('2026-10')).toBe('ต.ค. 69')
  })
})

const DASH = resolve(__dirname, '../../../reference/NOI-dashboard.html')
describe.skipIf(!existsSync(DASH))('owner dashboard history', () => {
  it('reads 9 months × 2 buildings; NOI split adds up and matches the page\'s monthly table', () => {
    const html = readFileSync(DASH, 'utf8')
    const rows = parseNoiDashboard(html)
    expect(rows).toHaveLength(18)
    expect(new Set(rows.map((r) => r.month)).size).toBe(9)
    // the page prints monthly NOI per building in its table; revenue − cost from the data object must agree with it
    const table = html.slice(html.indexOf('กำไรรายเดือน แยกอาคาร'))
    const jan = [...table.slice(0, table.indexOf('</tr>', table.indexOf('<td>ม.ค.</td>'))).slice(table.indexOf('<td>ม.ค.</td>')).matchAll(/<td[^>]*>(.*?)<\/td>/g)]
      .map((m) => Number(m[1].replace(/<[^>]+>|,/g, '')))
    const n = rows.find((r) => r.month === '2026-01' && r.building_id === 'N')!
    expect(Math.round(n.revenue - n.cost)).toBe(jan[4])
    expect([n.elec_margin, n.water_margin]).toEqual([jan[2], jan[3]])
  })
})
