// Migration 0332 narrowed `medical_profiles` to manager-or-self: a child no
// longer selects the household's conditions, medications, physicians or
// emergency contacts. Two services had to move for that to be safe.
//
// `foodProfile` (lib/services/meals) and `addFromMealPlan` (lib/services/
// groceries) both read the family's ALLERGIES on behalf of whoever is
// planning, and both go through `scope.db` — which `scopeFromUserContext`
// fills with the CALLER's client, not a service client. RLS does not error; it
// returns fewer rows. So a child running either one against the narrowed table
// would get `{ data: [], error: null }`, and the fail-closed guard in front of
// the grocery read — the one whose comment says it exists to stop "putting
// peanut butter on the list" — would pass with zero allergies.
//
// These tests describe that exact world: `medical_profiles` reads EMPTY, as it
// does for a child, while `family_allergies()` still answers. If either service
// is ever moved back to a direct select, the household goes allergy-free here
// and these go red.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { foodProfile } from '@/lib/services/meals';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-allergy-1';

/**
 * A child's view of the database after 0332: `medical_profiles` answers with
 * nothing at all — no error, no rows — and the narrow door still opens.
 */
function childsClient() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    rpc: {
      family_allergies: (args) => (args.p_family_id === FAMILY
        ? [
          { member_id: 'member-kid', allergies: 'Peanuts' },
          { member_id: 'member-parent', allergies: null },
        ]
        : []),
    },
  });
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'auth-parent', display_name: 'Dana', role: 'parent', is_active: true, color: null, avatar_url: null, birthday: null },
    { id: 'member-kid', family_id: FAMILY, user_id: 'auth-kid', display_name: 'Rae', role: 'child', is_active: true, color: null, avatar_url: null, birthday: null },
  ]);
  // Deliberately empty. This is what the table looks like to the child.
  db.seed('medical_profiles', []);
  return db;
}

function childScope(db: SupabaseClient<Database>): ServiceScope {
  return {
    db, familyId: FAMILY, userId: 'auth-kid', memberId: 'member-kid', role: 'child',
    actorKind: 'member', tz: 'America/New_York', now: new Date('2026-09-16T12:00:00Z'),
  };
}

describe('the allergy path survives the medical_profiles narrowing', () => {
  it('still knows about the peanut allergy when the child cannot read the table', async () => {
    const db = childsClient();
    const res = await foodProfile(childScope(db));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.household.allergies).toContain('peanuts');
    const rae = res.data.members.find((m) => m.name === 'Rae');
    expect(rae?.allergies).toContain('peanuts');
  });

  it('asks about the caller’s own family and no other', async () => {
    const db = childsClient();
    const seen: unknown[] = [];
    const realRpc = db.rpc.bind(db);
    db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'family_allergies') seen.push(args);
      return realRpc(name, args);
    }) as typeof db.rpc;

    await foodProfile(childScope(db));
    expect(seen).toEqual([{ p_family_id: FAMILY }]);
  });

  it('fails rather than reporting an allergy-free household when the door is shut', async () => {
    // What the real function does to a caller who is not a member of this
    // family: it raises. The fake's built-in handler would answer from the
    // (empty) table, which is the very thing 0332 made unsafe to rely on, so
    // this one is stated explicitly.
    const db = createInMemorySupabase<SupabaseClient<Database>>({
      rpc: { family_allergies: () => { throw new Error('not a member of this family'); } },
    });
    db.seed('family_members', [
      { id: 'member-kid', family_id: FAMILY, user_id: 'auth-kid', display_name: 'Rae', role: 'child', is_active: true, color: null, avatar_url: null, birthday: null },
    ]);

    const res = await foodProfile(childScope(db));
    // An unreachable allergy list is a failure, not an empty one. `family_allergies`
    // raises for a non-member precisely so this branch exists to be taken.
    expect(res.ok).toBe(false);
  });
});

describe('neither service reads medical_profiles directly', () => {
  // A source assertion, because this is the one thing a behavioural test cannot
  // see: a direct select would be INDISTINGUISHABLE from the RPC on a manager's
  // client, which is whose client the tests above would otherwise be written
  // with. The regression only appears for a child, in production.
  const files = ['lib/services/groceries/index.ts', 'lib/services/meals/index.ts'];

  for (const file of files) {
    it(`${file} reaches allergies through family_allergies()`, () => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
      expect(code).not.toMatch(/from\(\s*['"]medical_profiles['"]\s*\)/);
      expect(code).toContain("rpc('family_allergies'");
    });
  }
});
