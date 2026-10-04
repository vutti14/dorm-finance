// Offline queue (SPEC §10 item 9c, client side): items survive a dead connection, upload once after reconnect,
// and a resend uses the same client_ref + photo paths so the server can de-duplicate.
import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach } from 'vitest'
import { enqueue, flush, listOps, removeOp, type OpKind } from '../../src/lib/offline'

const blob = () => new Blob(['x'], { type: 'image/jpeg' })

function fakeServer() {
  const seen = new Set<string>()
  const calls: { kind: OpKind; payload: Record<string, unknown> }[] = []
  const uploads: string[] = []
  let online = false
  return {
    calls, uploads, seen,
    setOnline(v: boolean) { online = v },
    sender: {
      upload: async (_b: Blob, path: string) => {
        if (!online) throw new Error('Failed to fetch')
        uploads.push(path)
        return path
      },
      call: async (kind: OpKind, payload: Record<string, unknown>) => {
        if (!online) throw new Error('Failed to fetch')
        calls.push({ kind, payload })
        const ref = String(payload.client_ref)
        if (seen.has(ref)) return { duplicate: true }
        seen.add(ref)
        if (payload.work_note === 'refuse') throw new Error('ช่างทดสอบ ลงเวลาวันนี้ไปแล้ว')
        return { done: ['ok'] }
      },
    },
  }
}

describe('offline queue', () => {
  beforeEach(async () => { for (const op of await listOps()) await removeOp(op.id) })

  it('keeps items while offline and sends them once, in order, after reconnect', async () => {
    const s = fakeServer()
    await enqueue({ kind: 'check_in', payload: { project_id: 'N', work_note: 'ซ่อม' }, photos: [{ field: 'selfie_path', blobs: [blob()], multi: false }], folder: 'crew/u1', label: 'ลงเวลาเข้า' })
    await enqueue({ kind: 'check_out', payload: { note: 'เสร็จ' }, photos: [{ field: 'photos', blobs: [blob(), blob()], multi: true }], folder: 'crew/u1', label: 'ส่งงาน' })
    const r1 = await flush(s.sender)
    expect(r1).toMatchObject({ sent: [], failed: [], waiting: 2 })
    expect((await listOps()).map((o) => o.attempts)).toEqual([1, 0])

    s.setOnline(true)
    const r2 = await flush(s.sender)
    expect(r2.sent.map((x) => x.op.kind)).toEqual(['check_in', 'check_out'])
    expect(await listOps()).toEqual([])
    const [cin, cout] = s.calls
    expect(cin.payload.selfie_path).toBe(`crew/u1/${cin.payload.client_ref}-selfie_path-0.jpg`)
    expect(cout.payload.photos).toEqual([0, 1].map((i) => `crew/u1/${cout.payload.client_ref}-photos-${i}.jpg`))
    // nothing left → a second flush sends nothing
    expect((await flush(s.sender)).sent).toEqual([])
    expect(s.calls).toHaveLength(2)
  })

  it('a reply lost after the server saved it: the resend carries the same client_ref and is de-duplicated', async () => {
    const s = fakeServer()
    s.setOnline(true)
    const op = await enqueue({ kind: 'claim_material', payload: { shop: 'ไทวัสดุ', amount: 100, project_id: 'N' }, photos: [], folder: 'crew/u1', label: 'ขอเบิกวัสดุ' })
    s.seen.add(op.id) // server already has it
    const r = await flush(s.sender)
    expect(r.sent[0].result).toEqual({ duplicate: true })
    expect(s.calls[0].payload.client_ref).toBe(op.id)
  })

  it('a refusal from the server (not a network error) is dropped and reported, the rest continue', async () => {
    const s = fakeServer()
    s.setOnline(true)
    await enqueue({ kind: 'check_in', payload: { project_id: 'N', work_note: 'refuse' }, photos: [], folder: 'f', label: 'ลงเวลาเข้า' })
    await enqueue({ kind: 'check_out', payload: { note: 'ok' }, photos: [], folder: 'f', label: 'ส่งงาน' })
    const r = await flush(s.sender)
    expect(r.failed.map((f) => f.error)).toEqual(['ช่างทดสอบ ลงเวลาวันนี้ไปแล้ว'])
    expect(r.sent.map((x) => x.op.kind)).toEqual(['check_out'])
    expect(await listOps()).toEqual([])
  })

  it('two flushes at the same time do not send twice', async () => {
    const s = fakeServer()
    s.setOnline(true)
    await enqueue({ kind: 'check_in', payload: { project_id: 'N', work_note: 'x' }, photos: [], folder: 'f', label: 'a' })
    await Promise.all([flush(s.sender), flush(s.sender)])
    expect(s.calls).toHaveLength(1)
  })
})
