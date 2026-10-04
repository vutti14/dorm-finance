// Live data: load with a query, re-load whenever another person changes one of the given tables (SPEC §1.2).
// One realtime channel per browser listens to `live_pulse` — the database sends at most one signal per table per
// transaction, so importing or issuing a whole round is one message, not hundreds (Supabase rate-limits row streams).
// RLS still applies to every reload; the pulse itself only carries a table name and a time.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, errText, CHANGED_EVENT } from './supabase'

type Listener = { tables: Set<string>; fire: () => void }
const listeners = new Set<Listener>()
const statusListeners = new Set<(ok: boolean) => void>()
let channel: RealtimeChannel | null = null
let connected = true

function ensureChannel() {
  if (channel) return
  channel = supabase.channel('live-pulse')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_pulse' }, (p) => {
      const topic = (p.new as { topic?: string } | null)?.topic
      for (const l of listeners) if (!topic || l.tables.has(topic)) l.fire()
    })
  channel.subscribe((status) => {
    connected = status === 'SUBSCRIBED'
    for (const s of statusListeners) s(connected)
    if (connected) for (const l of listeners) l.fire()   // catch up on anything missed while disconnected
  })
}

// a new login brings a new token: rejoin so the channel runs as that user
supabase.auth.onAuthStateChange((event) => {
  if ((event === 'SIGNED_IN' || event === 'SIGNED_OUT') && channel) {
    supabase.removeChannel(channel)
    channel = null
    if (listeners.size) ensureChannel()
  }
})

export function useLive<T>(load: () => Promise<T>, tables: string[], deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isConnected, setConnected] = useState(connected)
  const loadRef = useRef(load)
  loadRef.current = load
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (e) {
      setError(errText(e))
    }
  }, [])

  useEffect(() => {
    reload()
    const l: Listener = {
      tables: new Set(tables),
      fire: () => { clearTimeout(timer.current); timer.current = setTimeout(reload, 250) },
    }
    if (tables.length) { listeners.add(l); ensureChannel() }
    statusListeners.add(setConnected)
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    window.addEventListener(CHANGED_EVENT, onFocus)
    return () => {
      clearTimeout(timer.current)
      listeners.delete(l)
      statusListeners.delete(setConnected)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(CHANGED_EVENT, onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(','), ...deps])

  return { data, error, connected: isConnected, reload }
}
