// M4: instant check on the จดมิเตอร์ screen + the warnings shown next to an AI reading.
import { describe, expect, it } from 'vitest'
import { parseReading, previewElec, previewWater } from '../../src/lib/meter'
import { base64, checkReading, meterPrompt, type AiReading } from '../../../supabase/functions/read-meter/check'

const ai = (o: Partial<AiReading>): AiReading =>
  ({ reading: 1180, digits_seen: '01180', room_label_seen: null, confidence: 'high', problem: null, ...o })

describe('meter preview (same rules as the server)', () => {
  it('occupied room: units × rate', () => {
    expect(previewElec({ prev: 1100, curr: 1180, prevUnits: 100, roomStatus: 'occupied', rate: 8 }))
      .toEqual({ units: 80, amount: 640, flags: [] })
  })
  it('flags: missing, decreased, zero use, over 2×, vacant with use', () => {
    expect(previewElec({ prev: 1100, curr: null, prevUnits: 100, roomStatus: 'occupied', rate: 8 }).flags).toEqual(['missing_elec'])
    expect(previewElec({ prev: 1100, curr: 1090, prevUnits: 100, roomStatus: 'occupied', rate: 8 })).toEqual({ units: -10, amount: 0, flags: ['elec_decreased'] })
    expect(previewElec({ prev: 1100, curr: 1100, prevUnits: 100, roomStatus: 'staff', rate: 4.5 }).flags).toEqual(['occupied_zero_use'])
    expect(previewElec({ prev: 520, curr: 570, prevUnits: 20, roomStatus: 'occupied', rate: 8 }).flags).toEqual(['over_2x_last_month'])
    expect(previewElec({ prev: 200, curr: 205, prevUnits: 0, roomStatus: 'vacant', rate: 8 })).toEqual({ units: 5, amount: 0, flags: ['vacant_has_use'] })
    expect(previewWater({ prev: 12, curr: 15, roomStatus: 'occupied', rate: 30 })).toEqual({ units: 3, amount: 90, flags: [] })
  })
  it('parses typed readings', () => {
    expect(parseReading('1,180')).toBe(1180)
    expect(parseReading(' 01180 ')).toBe(1180)
    expect(parseReading('11a')).toBeNull()
    expect(parseReading('')).toBeNull()
  })
})

describe('AI reading checks', () => {
  it('clean reading → no warnings', () => {
    expect(checkReading(ai({}), 'B206', 1100, 100)).toEqual([])
  })
  it('unreadable photo → asks to type', () => {
    expect(checkReading(ai({ reading: null, problem: 'รูปเบลอ' }), 'B206', 1100, 100)).toEqual(['รูปเบลอ'])
  })
  it('wrong room sticker, low confidence, lower than last time, over 2×', () => {
    expect(checkReading(ai({ room_label_seen: 'B207' }), 'B206', 1100, 100)[0]).toMatch(/อาจไม่ใช่ห้อง B206/)
    expect(checkReading(ai({ room_label_seen: 'ห้อง b206' }), 'B206', 1100, 100)).toEqual([])
    expect(checkReading(ai({ confidence: 'low' }), 'B206', 1100, 100)[0]).toMatch(/ไม่มั่นใจ/)
    expect(checkReading(ai({ reading: 1000 }), 'B206', 1100, 100)[0]).toMatch(/น้อยกว่าเลขครั้งก่อน/)
    expect(checkReading(ai({ reading: 1400 }), 'B206', 1100, 100)[0]).toMatch(/เกิน 2 เท่า/)
  })
  it('prompt mentions the room and the previous number; base64 matches Node', () => {
    expect(meterPrompt('B206', 'elec', 1100)).toMatch(/B206[\s\S]*1100/)
    const bytes = new Uint8Array(70000).map((_, i) => i % 251)
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
