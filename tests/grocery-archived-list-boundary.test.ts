import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { ensureDefaultList } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';

// Archiving a shopping list is a family saying they are done with it. Writing
// into one anyway is the worst shape a bug can take here, because it SUCCEEDS:
// the caller is told the milk was added, and the milk is on a list nobody will
// open again.
//
// `grocery_lists` carries two columns that answer "is this archived" —
// `is_archived` from 0002 and `archived_at` from 0014 — and nothing in the
// application ever writes the first. The shopping module stamps the second. So
// an `is_archived`-only reader calls an archived list open, which is the exact
// trap lib/services/groceries documents at length and which two more readers
// had fallen into.

const FAMILY = 'fam-1';

function scopeFor(db: SupabaseClient<Database>): ServiceScope {
  return {
    db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent',
  } as unknown as ServiceScope;
}

function withLists(rows: Record<string, unknown>[]) {
  const db = createInMemorySupabase();
  db.seed('grocery_lists', rows);
  db.seed('grocery_items', []);
  return db;
}

const live = (id: string, over: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, name: id, is_archived: false, archived_at: null,
  created_at: '2026-01-01T00:00:00Z', ...over,
});

// The NAMED-list path is deliberately not filtered here: naming a list is the
// caller saying which one it means, and tests/grocery-write-path.test.ts pins
// that choice. This file is about the path where nothing named one.

describe('the default list is the one the family can still see', () => {
  it('skips an archived list and opens a new one rather than reusing it', async () => {
    const db = withLists([live('put-away', { archived_at: '2026-02-01T00:00:00Z' })]);
    const result = await ensureDefaultList(scopeFor(db as unknown as SupabaseClient<Database>));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).not.toBe('put-away');
      expect(result.data.created).toBe(true);
    }
  });

  it('takes the live one when there is both', async () => {
    const db = withLists([
      live('put-away', { archived_at: '2026-02-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' }),
      live('current', { created_at: '2026-03-01T00:00:00Z' }),
    ]);
    const result = await ensureDefaultList(scopeFor(db as unknown as SupabaseClient<Database>));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe('current');
  });
});

// The cases above pin ONE reader. The trap is that there are a dozen, spread
// across the web app, the API routes and the phone, and each was written by
// someone reading a neighbouring query rather than the migrations — which is
// how seven of them came to ask `is_archived` (never written) or nothing at all
// while the shopping module stamped `archived_at`. Fixing them one at a time
// leaves the next one free to be written the same way, so the rule is checked
// against the source: a `grocery_lists` read filters BOTH columns, or it is on
// the list below and says why.
describe('every grocery_lists reader asks both archive columns', () => {
  const ROOTS = ['lib', 'app', 'components', 'mobile/src'];
  // Reads that deliberately span archived lists. A caller naming an explicit
  // list id is saying which list it means; second-guessing that would be the
  // service overruling its caller (tests/grocery-write-path.test.ts pins it).
  const DELIBERATE = new Set(['lib/services/groceries/index.ts:eq(\'id\', listId)']);

  function selects(): { file: string; statement: string }[] {
    const found: { file: string; statement: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/from\('grocery_lists'\)/g)) {
          const end = text.indexOf(';', match.index!);
          const statement = text.slice(match.index!, end === -1 ? text.length : end).replace(/\s+/g, ' ');
          // Creating a list is not reading one, and neither is archiving it.
          if (!statement.includes('.select(') || /\.(insert|update|upsert|delete)\(/.test(statement)) continue;
          found.push({ file: full, statement });
        }
      }
    };
    for (const root of ROOTS) walk(root);
    return found;
  }

  const reads = selects();

  it('finds the readers at all', () => {
    // Guards that quietly stop matching pass forever. If this number falls, the
    // scan broke or the table was renamed — either way, look before lowering it.
    expect(reads.length).toBeGreaterThanOrEqual(10);
  });

  it.each(reads.map((read) => [read.file, read.statement] as const))('%s filters live lists', (file, statement) => {
    if ([...DELIBERATE].some((entry) => entry.startsWith(`${file}:`) && statement.includes(entry.slice(file.length + 1)))) return;
    expect(statement, `${file} must exclude lists the family archived`).toContain("eq('is_archived', false)");
    expect(statement, `${file} must exclude lists the family archived`).toContain("is('archived_at', null)");
  });
});
