// Display helpers: money 1,234.50 · Thai short dates "7 ต.ค. 69" · phone 095-406-0800

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** 1234.5 -> "1,234.50"; whole numbers -> "1,234" (as on the paper bills) */
export function fmt(n: number | string | null | undefined): string {
  const v = round2(Number(n) || 0)
  const whole = Number.isInteger(v)
  return v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })
}

/** "2026-10-07" -> "7 ต.ค. 69" */
export function thaiDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ''
  return `${d} ${TH_MONTHS[m - 1]} ${String(y + 543).slice(2)}`
}

export function fmtPhone(p: string | null | undefined): string {
  const d = (p || '').replace(/\D/g, '')
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || '—'
}

/** today in Asia/Bangkok as YYYY-MM-DD */
export function todayTH(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 864e5)
}

export const phoneOk = (p: string | null | undefined) => /^0\d{9}$/.test((p || '').replace(/\D/g, ''))
