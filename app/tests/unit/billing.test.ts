// SPEC §10 acceptance test 1 (importer + bill math) against reference/test_import_sample.xlsx
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseWorkbook, xDate } from '../../src/lib/importer'
import { computeRound } from '../../src/lib/billing'
import { thaiIdOk, maskThaiId } from '../../src/lib/thaiId'
import { billText } from '../../src/lib/billText'

const REF = process.env.REFERENCE_DIR || resolve(__dirname, '../../../reference')
const SAMPLE = resolve(REF, 'test_import_sample.xlsx')
const TEMPLATE = resolve(REF, 'แบบฟอร์มนำเข้าข้อมูลหอพัก-รอบบิลตค69.xlsx')
const haveSample = existsSync(SAMPLE)

describe('helpers', () => {
  it('reads Excel serials and Buddhist-year dates', () => {
    expect(xDate(46302)).toBe('2026-10-07')
    expect(xDate('07/10/2569')).toBe('2026-10-07')
    expect(xDate('7/10/2026')).toBe('2026-10-07')
    expect(xDate('')).toBeNull()
  })
  it('checks Thai ID checksum and masks it', () => {
    expect(thaiIdOk('1101700230708')).toBe(true)
    expect(thaiIdOk('1101700230705')).toBe(false)
    expect(thaiIdOk('123')).toBe(false)
    expect(maskThaiId('1101700230708')).toBe('x-xxxx-xxxxx-70-8')
  })
})

describe.skipIf(!haveSample)('acceptance 1 — import test_import_sample.xlsx', () => {
  const parsed = haveSample ? parseWorkbook(readFileSync(SAMPLE)) : { payload: null, errors: [] }
  const p = parsed.payload!
  const r = p ? computeRound(p) : null!

  it('parses without errors', () => {
    expect(parsed.errors).toEqual([])
    expect(p.settings.label).toBe('ต.ค. 69')
    expect(p.settings.due_date).toBe('2026-10-07')
    expect(p.settings.issue_date).toBe('2026-10-02')
    expect(p.rooms).toHaveLength(76)
  })

  it('B206 missing readings blocks issue', () => {
    const b = r.bills.find((x) => x.code === 'B206')!
    expect(b.flags).toContain('missing_elec')
    expect(r.blocking).toEqual(['B206'])
  })

  it('B207 elec decreased', () => {
    expect(r.bills.find((x) => x.code === 'B207')!.flags).toContain('elec_decreased')
  })

  it('vacant has use: 105 106 309 501 503 888VIP', () => {
    const v = r.bills.filter((b) => b.flags.includes('vacant_has_use')).map((b) => b.code).sort()
    expect(v).toEqual(['105', '106', '309', '501', '503', '888VIP'].sort())
  })

  it('round totals equal the workbook สรุปบิล', () => {
    expect(r.totals.N).toBe(197635)
    expect(r.totals.P).toBe(207180)
    expect(r.totals.all).toBe(404815)
    expect(r.totals.rent).toBe(271500)
    expect(r.totals.elec).toBe(77815)
    expect(r.totals.water).toBe(11400)
    expect(r.totals.service).toBe(1720)
    expect(r.totals.items).toBe(1300)
    expect(r.totals.carry).toBe(41080)
  })

  it('room 302 = 15,850; room 207 = 10,791 welfare', () => {
    expect(r.bills.find((b) => b.code === '302')!.total).toBe(15850)
    const s = r.bills.find((b) => b.code === '207')!
    expect(s.total).toBe(10791)
    expect(s.status).toBe('welfare')
  })

  it('every room matches the workbook สรุปบิล line by line', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(readFileSync(SAMPLE), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['สรุปบิล'], { header: 1, raw: true, defval: '' })
    let checked = 0
    for (const row of rows.slice(1)) {
      const code = String(row[1] ?? '').trim()
      if (!code || /^รวม/.test(code)) continue
      const b = r.bills.find((x) => x.code === code)!
      expect(b, code).toBeTruthy()
      expect([code, b.total]).toEqual([code, Number(row[10])])
      checked++
    }
    expect(checked).toBe(76)
  })

  it('warns about the carry-in row whose room name does not match', () => {
    const w = r.warnings.find((x) => x.sheet === 'ยอดค้างยกมา')!
    expect(w.room).toBe('B5-H (ออฟฟิตเก่า)')
    expect(w.amount).toBe(8976)
    expect(w.message).toContain('"B5-H"')
  })

  it('LINE bill text follows the prototype format', () => {
    const b = r.bills.find((x) => x.code === '302')!
    const text = billText(b, {
      label: p.settings.label, due_date: p.settings.due_date!,
      names: { N: 'นารา แมนชั่น', P: 'ปรายดาวรีสอร์ท' },
      bank: { N: { bank: 'กสิกร', name: 'นารา', no: '123-4-56789-0' } }, contact: '081-234-5678',
    }, 0)
    expect(text.split('\n')).toEqual([
      'นารา แมนชั่น · ห้อง 302',
      'แจ้งค่าเช่า ต.ค. 69',
      '',
      'ค่าเช่า 4,400',
      'ค่าไฟ 7,746 → 8,081 = 335 หน่วย × 8 = 2,680',
      'ค่าน้ำ 375 → 382 = 7 หน่วย × 30 = 210',
      'ค่าปรับจ่ายช้ารอบ ก.ย. (ตัวอย่าง ลบได้) 1,300',
      'ค้างชำระยกมา 7,260',
      '',
      'รวมทั้งสิ้น 15,850 บาท',
      'กรุณาชำระภายใน 7 ต.ค. 69',
      'โอนเข้า กสิกร นารา 123-4-56789-0',
      'ส่งสลิป/สอบถาม 081-234-5678',
    ])
    const staff = billText(r.bills.find((x) => x.code === '207')!, { label: 'ต.ค. 69', due_date: '2026-10-07', names: {}, bank: {}, contact: null }, 0)
    expect(staff.split('\n').at(-1)).toBe('สวัสดิการพนักงาน — หักจากค่าตอบแทน ไม่ต้องโอน')
    expect(staff).toContain('ค่าบริการประจำ 1,000')
  })
})

describe.skipIf(!existsSync(TEMPLATE))('real October template (meters not read yet)', () => {
  it('parses and blocks issue until meters are read', () => {
    const { payload, errors } = parseWorkbook(readFileSync(TEMPLATE))
    expect(errors).toEqual([])
    const r = computeRound(payload!)
    expect(r.blocking.length).toBeGreaterThan(0)
  })
})
