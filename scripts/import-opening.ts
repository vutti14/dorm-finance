// One-time opening data (SPEC §8.2). Run once against the production database after the migrations:
//   cd scripts && npm install && DATABASE_URL=postgresql://... npx tsx import-opening.ts [--reference ../reference]
// Loads:
//   reference/opening.json            wallet opening balances at 2026-09-30 + owner-account opening figures
//   reference/history/*.csv           Jan–Sep 2026 handwritten books → ledger_history (read-only, never ledger_entries)
//   reference/NOI-dashboard.html      Jan–Sep 2026 monthly NOI per building → noi_history (M5 report history)
// Safe to re-run: skips anything already loaded.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { parseNoiDashboard } from './noi-history'

const argRef = process.argv.indexOf('--reference')
const REF = resolve(argRef > 0 ? process.argv[argRef + 1] : resolve(__dirname, '../reference'))
const DB = process.env.DATABASE_URL
if (!DB) throw new Error('set DATABASE_URL (Supabase → Project settings → Database → connection string)')

/** RFC 4180 CSV (quoted fields, commas and newlines inside quotes), strips a UTF-8 BOM */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = [], field = '', q = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') q = false
      else field += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

const n = (v: string | undefined) => (v == null || v.trim() === '' ? null : Number(v.replace(/,/g, '')))

async function main() {
  const db = new pg.Client({ connectionString: DB })
  await db.connect()
  try {
    await db.query('begin')

    // ---- opening balances
    const op = resolve(REF, 'opening.json')
    if (existsSync(op)) {
      const o = JSON.parse(readFileSync(op, 'utf8'))
      for (const [wallet, amount] of Object.entries(o.wallets as Record<string, number>)) {
        const { rowCount } = await db.query(
          `insert into ledger_entries (on_date, wallet_id, amount, category, description)
           select $1, $2, $3, 'opening_balance', 'ยอดยกมา ' || w.name || ' (สมุดมือ)' from wallets w
            where w.id = $2 and not exists (select 1 from ledger_entries where wallet_id = $2 and category = 'opening_balance')`,
          [o.as_of, wallet, amount])
        console.log(`opening ${wallet} ${amount} ${rowCount ? 'loaded' : 'already there — skipped'}`)
      }
      if (o.owner_opening) {
        await db.query(
          `insert into settings (key, value) values ('owner_opening', $1) on conflict (key) do nothing`,
          [JSON.stringify({ ...o.owner_opening, as_of: o.as_of })])
      }
    } else console.log('no opening.json — skipped balances')

    // ---- ledger history
    const [{ c }] = (await db.query(`select count(*)::int c from ledger_history`)).rows
    if (c > 0) {
      console.log(`ledger_history already has ${c} rows — skipped`)
    } else {
      const books: [string, string, (r: Record<string, string>) => unknown[]][] = [
        ['acc3_central_book.csv', 'A3', (r) => [r.date, r.desc, r.cat, r.site || null, n(r.in), n(r.out), n(r.bal)]],
        ['nara_book.csv', 'N', (r) => [r.date, r.desc, r.cat, null, n(r.in), n(r.out), n(r.bal)]],
        ['praydao_book.csv', 'P', (r) => [r.date, r.desc, r.cat, null, n(r.in), n(r.out), n(r.bal)]],
        ['real_estate_allocation.csv', 'RE_ALLOC', (r) => [r['วันที่'], r['รายการในสมุด'], r['ประเภท'], r['โลเคชั่น'], null, n(r['จำนวนเงิน (หลังแบ่งสัดส่วน)']), null]],
      ]
      for (const [file, book, map] of books) {
        const p = resolve(REF, 'history', file)
        if (!existsSync(p)) { console.log(`missing ${file} — skipped`); continue }
        const [head, ...rows] = parseCsv(readFileSync(p, 'utf8'))
        let k = 0
        for (const [i, cells] of rows.entries()) {
          const rec = Object.fromEntries(head.map((h, j) => [h.trim(), cells[j] ?? '']))
          const v = map(rec)
          if (!v[0]) continue
          await db.query(
            `insert into ledger_history (book, on_date, description, category, site, amount_in, amount_out, balance, source_row)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [book, ...v, i + 2])
          k++
        }
        console.log(`${file}: ${k} rows → ledger_history (${book})`)
      }
    }
    // ---- NOI history (M5)
    const nh = resolve(REF, 'NOI-dashboard.html')
    const [{ c: hc }] = (await db.query(`select count(*)::int c from noi_history`)).rows
    if (hc > 0) console.log(`noi_history already has ${hc} rows — skipped`)
    else if (!existsSync(nh)) console.log('no NOI-dashboard.html — skipped NOI history')
    else {
      const rows = parseNoiDashboard(readFileSync(nh, 'utf8'))
      for (const r of rows) {
        await db.query(`insert into noi_history (month, building_id, revenue, cost, elec_margin, water_margin, capex, deposits_net)
                        values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.month, r.building_id, r.revenue, r.cost, r.elec_margin, r.water_margin, r.capex, r.deposits_net])
      }
      console.log(`NOI-dashboard.html: ${rows.length} rows → noi_history`)
    }
    await db.query('commit')
  } catch (e) {
    await db.query('rollback')
    throw e
  } finally {
    await db.end()
  }
}

if (process.argv[1] && /import-opening/.test(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
