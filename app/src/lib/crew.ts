// Crew helpers: GPS, offline-queue wiring (sender + auto-flush), live queue count
import { useCallback, useEffect, useState } from 'react'
import { supabase, errText, notifyChanged } from './supabase'
import { uploadBlobAt } from './photos'
import { enqueue, flush, listOps, onQueueChange, type FlushResult, type OpKind, type QueuedOp } from './offline'

export interface Pos { lat: number; lng: number; accuracy: number }

/** GPS with high accuracy, 10 s timeout (SPEC §4.8); null when refused or unavailable */
export function getPosition(timeout = 10000): Promise<Pos | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    )
  })
}

const RPC: Record<OpKind, string> = { check_in: 'check_in', check_out: 'check_out', claim_material: 'claim_material' }

export const sender = {
  upload: (blob: Blob, path: string) => uploadBlobAt(blob, path),
  call: async (kind: OpKind, payload: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(RPC[kind], { payload })
    if (error) throw new Error(errText(error))
    notifyChanged()
    return data
  },
}

/** queue an item and try to send it right away; resolves with the server answer, or null when it stays queued */
export async function submitQueued(op: Omit<QueuedOp, 'id' | 'created_at' | 'attempts'>): Promise<{ queued: true } | { queued: false; result: unknown } > {
  const q = await enqueue(op)
  const r = await flush(sender)
  const mine = r.sent.find((x) => x.op.id === q.id)
  if (mine) return { queued: false, result: mine.result }
  const failed = r.failed.find((x) => x.op.id === q.id)
  if (failed) throw new Error(failed.error)
  return { queued: true }
}

/** live "รอส่ง n รายการ" + background flushing whenever the connection comes back */
export function useQueue(onResult?: (r: FlushResult) => void) {
  const [ops, setOps] = useState<QueuedOp[]>([])
  const refresh = useCallback(() => { listOps().then(setOps).catch(() => setOps([])) }, [])
  useEffect(() => {
    refresh()
    const off = onQueueChange(refresh)
    const tryFlush = () => { if (navigator.onLine) flush(sender).then((r) => { if (r.sent.length || r.failed.length) onResult?.(r) }).catch(() => {}) }
    window.addEventListener('online', tryFlush)
    const t = setInterval(tryFlush, 20000)
    tryFlush()
    return () => { off(); window.removeEventListener('online', tryFlush); clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { ops, retry: () => flush(sender).then((r) => { onResult?.(r); return r }) }
}
