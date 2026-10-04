// Guards for things plain Postgres does not catch but hosted Supabase does.
import { describe, expect, it, afterAll } from 'vitest'
import { URL, pool, su } from './helpers'

describe.skipIf(!URL)('sql lint', () => {
  afterAll(async () => { await pool?.end() })
  it('no UPDATE / DELETE without WHERE in our functions (Supabase pg_safeupdate rejects them on API calls)', async () => {
    const fns = await su(`select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.prolang = (select oid from pg_language where lanname = 'plpgsql')`)
    const bad: string[] = []
    for (const f of fns) {
      for (const m of String(f.prosrc).matchAll(/\b(update\s+[a-z_]+(?:\s+[a-z]+)?\s+set|delete\s+from\s+[a-z_]+)[^;]*;/gi)) {
        if (!/\bwhere\b/i.test(m[0])) bad.push(`${f.proname}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
