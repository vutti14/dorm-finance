// POST { photo_path, room_code, kind: 'elec' | 'water', prev?, prev_units? }
//   → { reading, digits_seen, room_label_seen, confidence, problem, warnings[] }
// Reads the meter number from a photo already uploaded to the private "photos" bucket (meters/...), using Claude
// vision. Only a suggestion: the phone pre-fills the box and the person confirms every reading (SPEC §9 M4).
// Needs the function secret ANTHROPIC_API_KEY (supabase secrets set …) — never in the app or the repo.
import Anthropic from 'npm:@anthropic-ai/sdk@^0.131.0'
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@^0.131.0/helpers/zod'
import { z } from 'npm:zod@^4'
import { admin, caller, cors, fail, json } from '../_shared/util.ts'
import { base64, checkReading, meterPrompt, type AiReading } from './check.ts'

const MAY_READ = ['ceo', 'manager', 'finance_field']
const MODEL = Deno.env.get('METER_AI_MODEL') || 'claude-opus-5-5'

const Reading = z.object({
  reading: z.number().int().nullable(),
  digits_seen: z.string(),
  room_label_seen: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  problem: z.string().nullable(),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('method not allowed', 405)

  const me = await caller(req)
  if (!me || !MAY_READ.includes(me.role)) return fail('คุณไม่มีสิทธิ์จดมิเตอร์', 403)
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return fail('ยังไม่ได้เปิดใช้ AI อ่านมิเตอร์ — พิมพ์เลขเองได้ตามปกติ', 503)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return fail('ข้อมูลไม่ถูกต้อง') }
  const path = String(body.photo_path ?? '')
  const room = String(body.room_code ?? '').slice(0, 60)
  const kind = body.kind === 'water' ? 'water' : 'elec'
  const prev = Number.isFinite(Number(body.prev)) && body.prev !== null && body.prev !== '' ? Number(body.prev) : null
  const prevUnits = Number.isFinite(Number(body.prev_units)) && body.prev_units !== null ? Number(body.prev_units) : null
  if (!/^meters\/[\w\-./]+\.jpg$/.test(path) || path.includes('..')) return fail('ที่เก็บรูปมิเตอร์ไม่ถูกต้อง')
  if (!room) return fail('ไม่ระบุห้อง')

  const { data: file, error } = await admin().storage.from('photos').download(path)
  if (error || !file) return fail('ไม่พบรูปมิเตอร์ — ถ่ายใหม่อีกครั้ง', 404)
  if (file.size > 5 * 1024 * 1024) return fail('รูปใหญ่เกินไป')
  const data = base64(new Uint8Array(await file.arrayBuffer()))

  try {
    const client = new Anthropic()
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: meterPrompt(room, kind, prev) },
        ],
      }],
      output_config: { format: zodOutputFormat(Reading), effort: 'low' },
    })
    if (res.stop_reason === 'refusal' || !res.parsed_output) {
      return json({ reading: null, digits_seen: '', room_label_seen: null, confidence: 'low',
                    problem: 'AI อ่านรูปนี้ไม่ได้ — พิมพ์เลขเอง', warnings: ['AI อ่านรูปนี้ไม่ได้ — พิมพ์เลขเอง'] })
    }
    const ai = res.parsed_output as AiReading
    return json({ ...ai, warnings: checkReading(ai, room, prev, prevUnits) })
  } catch (e) {
    console.error('read-meter', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e)
    return fail('AI อ่านมิเตอร์ไม่สำเร็จตอนนี้ — พิมพ์เลขเองได้เลย', 502)
  }
})
