import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

type ToastFn = (text: string, isError?: boolean) => void
const ToastCtx = createContext<ToastFn>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ text: string; err: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const show = useCallback<ToastFn>((text, err = false) => {
    setT({ text, err })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setT(null), err ? 5000 : 2600)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.err ? 'err' : ''}`} role="status">{t.text}</div>}
    </ToastCtx.Provider>
  )
}

/** run an async action with a busy flag and Thai toast on error */
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) => {
    if (busy) return undefined
    setBusy(true)
    try {
      const r = await fn()
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok)
      return r
    } catch (e) {
      toast((e as Error).message || 'เกิดข้อผิดพลาด', true)
      return undefined
    } finally {
      setBusy(false)
    }
  }, [busy, toast])
  return { busy, run }
}

export function Stat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: 'ok' | 'bad' }) {
  return (
    <div className="stat">
      <b className={tone === 'ok' ? 'ok' : tone === 'bad' ? 'flag' : ''} style={tone === 'bad' ? { fontSize: 22 } : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-base font-semibold m-0">{title}</h2>
          <button className="btn ghost sm" onClick={onClose}>ปิด</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Loading({ error }: { error?: string | null }) {
  return <div className="panel">{error ? <span className="flag">{error}</span> : <span className="muted">กำลังโหลด…</span>}</div>
}

export function Soon({ what, milestone }: { what: string; milestone: string }) {
  return (
    <div className="panel">
      <h2>{what}</h2>
      <p className="muted">ส่วนนี้จะเปิดใช้ในระยะ {milestone} — ตอนนี้ระบบเปิดใช้ส่วนบิลค่าห้องก่อน (M1)</p>
    </div>
  )
}
