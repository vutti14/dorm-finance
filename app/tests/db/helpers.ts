// Shared helpers for DB tests: run SQL as a given app user (role authenticated + JWT sub) in its own transaction.
import { randomUUID } from 'node:crypto'
import pg from 'pg'

export type Role = 'ceo' | 'manager' | 'finance_field' | 'finance' | 'auditor' | 'worker'
export const URL = process.env.DATABASE_URL
export const pool = URL ? new pg.Pool({ connectionString: URL, max: 10 }) : (null as unknown as pg.Pool)

export type Users = Record<string, string>

export function makeAs(users: Users) {
  async function as<T = any>(who: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = await pool.connect()
    try {
      await c.query('begin')
      if (who === 'anon') {
        await c.query(`set local role anon`)
      } else {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: users[who], role: 'authenticated' })])
        await c.query(`set local role authenticated`)
      }
      const r = await c.query(sql, params)
      await c.query('commit')
      return r.rows as T[]
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }
  const one = async <T = any>(who: string, sql: string, params: unknown[] = []) => (await as<T>(who, sql, params))[0]
  return { as, one }
}

export const su = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows

/** create a profile per entry: key → [role, phone] */
export async function createUsers(spec: Record<string, [Role, string]>): Promise<Users> {
  const users: Users = {}
  for (const [key, [role, phone]] of Object.entries(spec)) {
    const id = randomUUID()
    users[key] = id
    await su(`insert into auth.users (id, email) values ($1, $2)`, [id, `p${phone}@dorm.internal`])
    await su(`insert into profiles (id, display_name, phone, role) values ($1, $2, $3, $4)`, [id, key, phone, role])
  }
  return users
}
