// The persona seed (§46): four people, one family, and — the part that matters
// — the same four however many times it runs. A seed script that doubles its
// own household on the second run is one nobody dares put in CI.
import { describe, expect, it } from 'vitest';
import { PERSONAS, assertLocal, personaEmail, seedPersonas } from '../scripts/seed-personas.mjs';

type Row = Record<string, unknown>;

/** A Supabase admin stand-in with a real store, enough for insert/select/eq/limit. */
function makeAdmin() {
  const tables: Record<string, Row[]> = { families: [], family_members: [] };
  const users: Row[] = [];
  let seq = 0;

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let payload: Row | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      limit: () => builder,
      eq: (column: string, value: unknown) => { filters[column] = value; return builder; },
      insert: (row: Row) => { payload = row; return builder; },
      single: async () => {
        if (payload) {
          const row = { id: `${table}-${(seq += 1)}`, ...payload };
          tables[table].push(row);
          // What handle_new_family() does in Postgres: the creator is a parent.
          if (table === 'families') {
            tables.family_members.push({
              id: `family_members-${(seq += 1)}`, family_id: row.id, user_id: (payload as Row).created_by,
              role: 'parent', display_name: 'Casey Rivera', is_active: true,
            });
          }
          return { data: row, error: null };
        }
        const found = tables[table].filter((r) => Object.entries(filters).every(([c, v]) => r[c] === v));
        return { data: found[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        const found = tables[table].filter((r) => Object.entries(filters).every(([c, v]) => r[c] === v));
        resolve({ data: found, error: null });
      },
    };
    return builder;
  };

  const admin = {
    from,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users }, error: null }),
        createUser: async ({ email, user_metadata }: { email: string; user_metadata?: { full_name?: string } }) => {
          const user = { id: `user-${(seq += 1)}`, email, name: user_metadata?.full_name };
          users.push(user);
          return { data: { user }, error: null };
        },
      },
    },
  };
  return { admin, tables, users };
}

describe('seed-personas', () => {
  it('refuses a remote Supabase unless the operator says so explicitly', () => {
    const env = (extra: Record<string, string> = {}) => ({ ...process.env, ...extra });
    expect(() => assertLocal('https://abc.supabase.co', env())).toThrow(/Refusing/);
    expect(assertLocal('http://127.0.0.1:54321', env())).toBe(true);
    expect(assertLocal('https://abc.supabase.co', env({ E2E_ALLOW_REMOTE_SUPABASE: '1' }))).toBe(true);
    expect(() => assertLocal('', env())).toThrow(/required/);
  });

  it('creates the §46 cast: two parents, a teen with a login and a managed child', async () => {
    const { admin, tables, users } = makeAdmin();
    const { familyId, members } = await seedPersonas({ admin: admin as never });
    expect(familyId).toBeTruthy();
    expect(members).toHaveLength(PERSONAS.length);
    expect(members.filter((m: { userId: string | null }) => m.userId)).toHaveLength(3);
    expect(members.find((m: { key: string }) => m.key === 'child')?.userId).toBeNull();
    expect(users.map((u) => u.email)).toEqual([
      personaEmail('parent1'), personaEmail('parent2'), personaEmail('teen'),
    ]);
    expect(tables.family_members).toHaveLength(PERSONAS.length);
  });

  it('is idempotent: a second run reuses the family and the same people', async () => {
    const { admin, tables } = makeAdmin();
    const first = await seedPersonas({ admin: admin as never });
    const second = await seedPersonas({ admin: admin as never });
    expect(second.familyId).toBe(first.familyId);
    expect(tables.families).toHaveLength(1);
    expect(tables.family_members).toHaveLength(PERSONAS.length);
  });
});
