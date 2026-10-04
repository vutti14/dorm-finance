// Thai national ID: sum(d[i]*(13-i), i=0..11); check digit = (11 - sum % 11) % 10   (SPEC §4.5)

export function thaiIdOk(raw: string | null | undefined): boolean {
  const s = (raw || '').replace(/\D/g, '')
  if (s.length !== 13) return false
  let t = 0
  for (let i = 0; i < 12; i++) t += Number(s[i]) * (13 - i)
  return (11 - (t % 11)) % 10 === Number(s[12])
}

/** "x-xxxx-xxxxx-12-3" (SPEC §1.8) */
export function maskThaiId(raw: string | null | undefined): string {
  const s = (raw || '').replace(/\D/g, '')
  return s.length === 13 ? `x-xxxx-xxxxx-${s.slice(10, 12)}-${s[12]}` : '—'
}
