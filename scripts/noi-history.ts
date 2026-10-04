// Reads the owner's Jan–Sep 2026 NOI dashboard (reference/NOI-dashboard.html) into rows for noi_history.
// Revenue / cost / capex / deposits come from the page's data object; the monthly electricity and water margins from
// its "กำไรรายเดือน แยกอาคาร × ค่าห้อง / ไฟ / น้ำ" table (the data object has no billed-utility split).
export interface NoiHistoryRow {
  month: string; building_id: 'N' | 'P'; revenue: number; cost: number
  elec_margin: number; water_margin: number; capex: number; deposits_net: number
}

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const NAME: Record<string, 'N' | 'P'> = { 'นารา': 'N', 'ปรายดาว': 'P' }
const num = (s: string) => Number(s.replace(/<[^>]+>/g, '').replace(/,/g, '').trim())
const r2 = (x: number) => Math.round(x * 100) / 100

export function parseNoiDashboard(html: string): NoiHistoryRow[] {
  const m = html.match(/const D=(\{.*?\});const M=/s)
  if (!m) throw new Error('NOI-dashboard.html: ไม่พบข้อมูล (const D=…)')
  const D = JSON.parse(m[1]) as {
    M: string[]
    b: Record<string, { rev: Record<string, Record<string, number>>; cost: Record<string, Record<string, number>>
                        capex: Record<string, number>; dep: Record<string, number> }>
  }
  const t = html.indexOf('กำไรรายเดือน แยกอาคาร')
  if (t < 0) throw new Error('NOI-dashboard.html: ไม่พบตารางกำไรรายเดือน')
  const table = html.slice(t, html.indexOf('</table>', t))
  const margins = new Map<string, number[]>()
  for (const tr of table.match(/<tr><td>[^<]+<\/td>.*?<\/tr>/g) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1])
    const mi = TH_MONTH.indexOf(cells[0].trim())
    if (mi < 0) continue
    margins.set(cells[0].trim(), cells.slice(1).map(num))   // N rent, elec, water, NOI, P rent, elec, water, NOI, total
  }
  const out: NoiHistoryRow[] = []
  for (const month of D.M) {
    const th = TH_MONTH[Number(month.slice(5, 7)) - 1]
    const mg = margins.get(th)
    if (!mg) throw new Error(`NOI-dashboard.html: ไม่มีกำไรค่าไฟ/น้ำของเดือน ${th}`)
    for (const [name, b] of Object.entries(D.b)) {
      const id = NAME[name]
      if (!id) continue
      const sum = (o: Record<string, Record<string, number>>) => Object.values(o).reduce((s, line) => s + (line[month] || 0), 0)
      const off = id === 'N' ? 0 : 4
      out.push({
        month, building_id: id, revenue: r2(sum(b.rev)), cost: r2(sum(b.cost)),
        elec_margin: mg[off + 1], water_margin: mg[off + 2], capex: r2(b.capex[month] || 0), deposits_net: r2(b.dep[month] || 0),
      })
    }
  }
  return out
}
