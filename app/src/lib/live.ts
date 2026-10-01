// Live data: load with a query, re-load whenever Supabase Realtime reports a change on any of the given tables.
// Another person's change shows up in ~1 s without refresh (SPEC §1.2). RLS still applies to realtime events.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, errText, CHANGED_EVENT } from './supabase'

let channelSeq = 0

export function useLive<T>(load: () => Promise<T>, tables: string[], deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(true)
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
    const ch = supabase.channel(`live-${tables.join('-')}-${++channelSeq}`)
    for (const table of tables) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(reload, 250)
      })
    }
    ch.subscribe((status) => {
      setConnected(status === 'SUBSCRIBED')
      if (status === 'SUBSCRIBED') reload() // catch up on anything missed while disconnected
    })
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    window.addEventListener(CHANGED_EVENT, onFocus)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(CHANGED_EVENT, onFocus)
      supabase.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(','), ...deps])

  return { data, error, connected, reload }
}
