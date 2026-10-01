// Thumbnails from the private "photos" bucket via short-lived signed URLs, plus a camera/file picker
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadPhoto } from '../lib/photos'
import { useToast } from './ui'

const cache = new Map<string, { url: string; at: number }>()

export function Thumbs({ paths, label }: { paths: string[]; label?: string }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)
  const key = paths.join('|')
  useEffect(() => {
    const need = paths.filter((p) => { const c = cache.get(p); return !c || Date.now() - c.at > 8 * 60_000 })
    const done = () => setUrls(Object.fromEntries(paths.map((p) => [p, cache.get(p)?.url || ''])))
    if (!need.length) { done(); return }
    supabase.storage.from('photos').createSignedUrls(need, 600).then(({ data }) => {
      for (const d of data || []) if (d.signedUrl && d.path) cache.set(d.path, { url: d.signedUrl, at: Date.now() })
      done()
    })
  }, [key])
  if (!paths.length) return null
  return (
    <span className="inline-flex gap-1.5 flex-wrap items-center my-1">
      {label && <span className="muted mr-1">{label}</span>}
      {paths.map((p) => urls[p]
        ? <img key={p} src={urls[p]} alt={label || 'รูปแนบ'} className="w-[54px] h-[54px] object-cover rounded-md border cursor-zoom-in" style={{ borderColor: 'var(--line)' }} onClick={() => setZoom(urls[p])} />
        : <span key={p} className="w-[54px] h-[54px] rounded-md border inline-block" style={{ borderColor: 'var(--line)', background: 'var(--soft)' }} />)}
      {zoom && (
        <span className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: 'rgba(0,0,0,.8)' }} onClick={() => setZoom(null)}>
          <img src={zoom} alt="รูปขยาย" className="max-w-full max-h-full rounded-lg" />
        </span>
      )}
    </span>
  )
}

/** button that takes / picks photos, uploads them, and reports the storage paths */
export function PhotoPicker({ label, folder, multiple = true, capture = true, onAdd, disabled }: {
  label: string; folder: string; multiple?: boolean; capture?: boolean; onAdd: (paths: string[]) => void; disabled?: boolean
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <label className={`btn ghost sm ${disabled || busy ? 'opacity-40 pointer-events-none' : ''}`}>
      {busy ? 'กำลังอัปโหลด…' : label}
      <input type="file" accept="image/*" hidden multiple={multiple} {...(capture ? { capture: 'environment' as const } : {})}
             onChange={async (e) => {
               const files = Array.from(e.target.files || [])
               e.target.value = ''
               if (!files.length) return
               setBusy(true)
               try {
                 const paths: string[] = []
                 for (const f of files) paths.push(await uploadPhoto(f, folder))
                 onAdd(paths)
               } catch (x) {
                 toast((x as Error).message, true)
               } finally {
                 setBusy(false)
               }
             }} />
    </label>
  )
}
