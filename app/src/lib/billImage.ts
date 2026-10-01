// Bill as a picture (to send in LINE) and as a printable page (Save as PDF). Both are drawn from the same lines as the
// LINE text (billText), so the three never disagree. Uses the page's own Thai font — no PDF library, no server.

const FONT = '"IBM Plex Sans Thai", "Noto Sans Thai", sans-serif'

/** wrap one line to the given width using the canvas' own text measurement */
export function wrapLine(measure: (s: string) => number, line: string, width: number): string[] {
  if (measure(line) <= width) return [line]
  const out: string[] = []
  let cur = ''
  for (const word of line.split(/(\s+)/)) {
    if (measure(cur + word) <= width || !cur) cur += word
    else { out.push(cur.trimEnd()); cur = word.trimStart() }
  }
  if (cur) out.push(cur)
  return out
}

export async function billPng(text: string): Promise<Blob> {
  await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready
  const W = 720, PAD = 36, LH = 40
  const c = document.createElement('canvas')
  const g = c.getContext('2d')!
  g.font = `24px ${FONT}`
  const lines = text.split('\n')
  const rows: { s: string; bold: boolean; big: boolean }[] = []
  lines.forEach((l, i) => {
    const big = /^รวมทั้งสิ้น/.test(l)
    for (const s of wrapLine((x) => g.measureText(x).width, l, W - PAD * 2)) rows.push({ s, bold: i === 0 || big, big })
  })
  const head = 64
  c.width = W * 2; c.height = (head + PAD + rows.length * LH + PAD) * 2   // 2× for a sharp image on phones
  g.scale(2, 2)
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, c.height)
  g.fillStyle = '#17302B'; g.fillRect(0, 0, W, head)
  g.fillStyle = '#ffffff'; g.font = `600 26px ${FONT}`; g.textBaseline = 'middle'
  g.fillText(rows[0]?.s ?? '', PAD, head / 2)
  g.textBaseline = 'alphabetic'
  rows.slice(1).forEach((r, i) => {
    g.fillStyle = r.big ? '#17302B' : '#1f2a27'
    g.font = `${r.bold ? 600 : 400} ${r.big ? 28 : 24}px ${FONT}`
    g.fillText(r.s, PAD, head + PAD + (i + 1) * LH - 10)
  })
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('สร้างรูปบิลไม่ได้'))), 'image/png'))
}

/** share sheet on phones (pick LINE), download elsewhere */
export async function shareOrDownload(blob: Blob, filename: string, title: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type })
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
  if (nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title }); return 'shared' }
    catch (e) { if ((e as Error).name === 'AbortError') return 'shared' }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  return 'downloaded'
}
