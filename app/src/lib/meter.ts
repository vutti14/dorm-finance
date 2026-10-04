// Instant check on the จดมิเตอร์ screen, before saving. Same rules as meter_flags() / recompute_bill() on the server
// (SPEC §4.6); the server recomputes on save and is the source of truth.
import { round2 } from './format'
import type { MeterFlag } from './billing'

export interface MeterPreview { units: number | null; amount: number; flags: MeterFlag[] }

export function previewElec(o: {
  prev: number | null; curr: number | null; prevUnits: number | null; roomStatus: string; rate: number
}): MeterPreview {
  const billable = o.roomStatus === 'occupied' || o.roomStatus === 'staff'
  const units = o.prev != null && o.curr != null ? round2(o.curr - o.prev) : null
  const flags: MeterFlag[] = []
  if (billable && units == null) flags.push('missing_elec')
  if (units != null && units < 0) flags.push('elec_decreased')
  if (billable && units === 0) flags.push('occupied_zero_use')
  if (units != null && (o.prevUnits ?? 0) > 0 && units > 2 * (o.prevUnits as number)) flags.push('over_2x_last_month')
  if (!billable && units != null && units > 0) flags.push('vacant_has_use')
  return { units, amount: billable && units != null && units > 0 ? round2(units * o.rate) : 0, flags }
}

export function previewWater(o: { prev: number | null; curr: number | null; roomStatus: string; rate: number }): MeterPreview {
  const billable = o.roomStatus === 'occupied' || o.roomStatus === 'staff'
  const units = o.prev != null && o.curr != null ? round2(o.curr - o.prev) : null
  const flags: MeterFlag[] = []
  if (billable && units == null) flags.push('missing_water')
  if (units != null && units < 0) flags.push('water_decreased')
  if (!billable && units != null && units > 0) flags.push('vacant_has_use')
  return { units, amount: billable && units != null && units > 0 ? round2(units * o.rate) : 0, flags }
}

/** "1,180" / "01180" / "1180.5" typed or spoken → number, or null */
export function parseReading(s: string): number | null {
  const t = s.replace(/[,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}
