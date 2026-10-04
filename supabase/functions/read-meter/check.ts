// Pure helpers for read-meter (no imports, so the app's unit tests can run them too).

export interface AiReading {
  reading: number | null          // whole units shown on the meter, or null when it cannot be read
  digits_seen: string             // the digits exactly as seen, e.g. "01180" (helps a human compare)
  room_label_seen: string | null  // the room sticker in the photo, if any
  confidence: 'high' | 'medium' | 'low'
  problem: string | null          // short Thai reason when unreadable / doubtful
}

export const KIND_TH: Record<string, string> = { elec: 'มิเตอร์ไฟฟ้า', water: 'มิเตอร์น้ำ' }

export function meterPrompt(roomCode: string, kind: string, prev: number | null): string {
  return [
    `รูปนี้คือ${KIND_TH[kind] ?? 'มิเตอร์'}ของห้อง ${roomCode} ในหอพัก`,
    'อ่านเลขที่หน้าปัดแสดงตอนนี้ เป็นหน่วยเต็ม (kWh หรือ ลบ.ม.):',
    '- มิเตอร์จานหมุน/ตัวเลขกลิ้ง: อ่านเฉพาะช่องตัวเลขหลัก ไม่เอาช่องสีแดงหรือหลักหลังจุดทศนิยม',
    '- ถ้าตัวเลขกำลังหมุนอยู่ระหว่างสองค่า ให้เลือกค่าที่น้อยกว่า',
    '- มิเตอร์ดิจิทัล: อ่านค่าหน่วยสะสม (kWh) ไม่ใช่แรงดัน/กระแส/วันที่',
    prev != null
      ? `- เลขครั้งก่อนคือ ${prev} ใช้ดูจำนวนหลักได้ แต่ให้ตอบเลขที่เห็นในรูปจริง ห้ามเดา ถ้าเห็นไม่ชัดให้ confidence = "low"`
      : '- ให้ตอบเลขที่เห็นในรูปจริง ห้ามเดา',
    'ถ้าในรูปมีสติกเกอร์/ป้ายเลขห้อง ให้ใส่ใน room_label_seen ตามที่เห็น ถ้าไม่มีให้เป็น null',
    'ถ้าอ่านไม่ได้ (เบลอ แสงสะท้อน ไม่ใช่มิเตอร์) ให้ reading = null และเขียนเหตุผลสั้น ๆ เป็นภาษาไทยใน problem',
  ].join('\n')
}

const norm = (s: string) => s.replace(/\s|-|ห้อง/g, '').toUpperCase()

/** warnings the phone shows next to the AI number; the person still confirms every reading */
export function checkReading(ai: AiReading, roomCode: string, prev: number | null, prevUnits: number | null): string[] {
  const w: string[] = []
  if (ai.reading == null) return [ai.problem || 'อ่านเลขจากรูปไม่ได้ — พิมพ์เอง']
  if (ai.confidence !== 'high') w.push('AI ไม่มั่นใจ — ดูเลขในรูปเทียบอีกครั้ง')
  if (ai.room_label_seen && !norm(ai.room_label_seen).includes(norm(roomCode)) && !norm(roomCode).includes(norm(ai.room_label_seen))) {
    w.push(`ป้ายในรูปเขียน "${ai.room_label_seen}" — อาจไม่ใช่ห้อง ${roomCode}`)
  }
  if (prev != null) {
    const units = ai.reading - prev
    if (units < 0) w.push(`น้อยกว่าเลขครั้งก่อน (${prev}) — มิเตอร์ถูกเปลี่ยนหรืออ่านผิด`)
    else if (prevUnits != null && prevUnits > 0 && units > 2 * prevUnits) w.push(`ใช้ ${units} หน่วย เกิน 2 เท่าของเดือนก่อน (${prevUnits})`)
  }
  return w
}

export function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
