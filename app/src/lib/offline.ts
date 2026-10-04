// Offline queue for the crew app (SPEC §4.8 "weak signal at the site"). Check-in, check-out and material claims are
// stored in IndexedDB with their (already compressed) photos, then sent when the connection is back.
// Every item carries a client_ref = its queue id, and the server ignores a client_ref it has already seen,
// so a resend after a lost reply never creates a duplicate. Server time is the official timestamp; the device time
// at the moment of pressing the button travels along as device_at.

export type OpKind = 'check_in' | 'check_out' | 'claim_material'
export interface QueuedOp {
  id: string                       // also the client_ref sent to the server
  kind: OpKind
  payload: Record<string, unknown> // RPC payload without photo paths
  photos: { field: string; blobs: Blob[]; multi: boolean }[]
  folder: string                   // storage folder, e.g. crew/<auth uid>
  label: string                    // shown in "รอส่ง n รายการ"
  created_at: string
  attempts: number
  last_error?: string
}

export interface Sender {
  upload: (blob: Blob, path: string) => Promise<string>
  call: (kind: OpKind, payload: Record<string, unknown>) => Promise<unknown>
}

const DB = 'dorm-offline'
const STORE = 'ops'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    t.oncomplete = () => { db.close(); resolve(req ? (req as IDBRequest<T>).result : undefined) }
    t.onerror = () => { db.close(); reject(t.error) }
  })
}

export const listOps = async () => ((await tx<QueuedOp[]>('readonly', (s) => s.getAll())) || []).sort((a, b) => a.created_at.localeCompare(b.created_at))
export const putOp = (op: QueuedOp) => tx('readwrite', (s) => { s.put(op) })
export const removeOp = (id: string) => tx('readwrite', (s) => { s.delete(id) })

const listeners = new Set<() => void>()
export function onQueueChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn) }
const changed = () => listeners.forEach((f) => f())

export async function enqueue(op: Omit<QueuedOp, 'id' | 'created_at' | 'attempts'> & { id?: string }): Promise<QueuedOp> {
  const full: QueuedOp = { ...op, id: op.id || crypto.randomUUID(), created_at: new Date().toISOString(), attempts: 0 }
  await putOp(full)
  changed()
  return full
}

/** a network problem (retry later) vs. a real answer from the server (stop retrying, show it) */
export function isNetworkError(e: unknown): boolean {
  const m = String((e as Error)?.message || e)
  return /Failed to fetch|NetworkError|network|timeout|เชื่อมต่อไม่ได้|Load failed|ERR_INTERNET|503|502|504/i.test(m)
}

export interface FlushResult { sent: { op: QueuedOp; result: unknown }[]; failed: { op: QueuedOp; error: string }[]; waiting: number }

let flushing: Promise<FlushResult> | null = null

/** send everything in order; stops at the first network failure (keeps the rest for later) */
export function flush(sender: Sender): Promise<FlushResult> {
  if (flushing) return flushing
  flushing = (async () => {
    const out: FlushResult = { sent: [], failed: [], waiting: 0 }
    const ops = await listOps()
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k]
      try {
        const payload: Record<string, unknown> = { ...op.payload, client_ref: op.id }
        for (const p of op.photos) {
          const paths: string[] = []
          for (let i = 0; i < p.blobs.length; i++) paths.push(await sender.upload(p.blobs[i], `${op.folder}/${op.id}-${p.field}-${i}.jpg`))
          payload[p.field] = p.multi ? paths : paths[0]
        }
        const result = await sender.call(op.kind, payload)
        await removeOp(op.id)
        out.sent.push({ op, result })
      } catch (e) {
        if (isNetworkError(e)) {
          await putOp({ ...op, attempts: op.attempts + 1, last_error: String((e as Error).message || e) })
          out.waiting = ops.length - k
          break
        }
        // the server refused (e.g. already checked in): drop it and tell the person
        await removeOp(op.id)
        out.failed.push({ op, error: String((e as Error).message || e) })
      }
    }
    changed()
    return out
  })().finally(() => { flushing = null })
  return flushing
}
