// §7 — the family's memory goes through the service, and the service has a rule
// the database does not.
//
// `forgetFact` has always ended with:
//
//   "Only a parent or adult can forget a memory about someone else."
//
// Migration 0264 gates `medical` and `account` rows to managers and NOTHING
// else. So on every other category — a preference, a size, a milestone — a CHILD
// could edit or delete a memory about a sibling straight from
// `knowledge-base-module` or `life-events-module`, because both filtered `id`
// alone. Proven against the replayed schema before this was written: acting as a
// child, deleting a sibling's `preference` fact removed one row.
//
// `updateFact` is by ID and carries the same rule. It is deliberately NOT
// `rememberFact`, which upserts by key: editing a fact whose label changed would
// have created a second memory rather than renaming the first.
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { forgetFact, updateFact } from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** A child acts as themselves; a parent acts for the household. */
function scopeAs(role: 'parent' | 'child', memberId: string): ServiceScope {
  return {
    db, familyId: FAMILY, userId: `user-${memberId}`, memberId,
    role, actorKind: 'member', tz: 'America/New_York',
  };
}
const fact = (id: string) => db.table('family_facts').find((r) => r.id === id);

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_facts: { notes: null, is_pinned: false, source: 'user', confidence: 100, expires_at: null },
      audit_logs: { resource_id: null, metadata: null },
    },
  });
  db.seed('family_facts', [
    { id: 'mine', family_id: FAMILY, member_id: 'kid', category: 'preference', label: 'Favourite colour', value: 'green' },
    { id: 'siblings', family_id: FAMILY, member_id: 'sibling', category: 'preference', label: 'Favourite colour', value: 'blue' },
  ]);
});

describe('a memory about someone else', () => {
  it('refuses a child editing their sibling\'s memory', async () => {
    const res = await updateFact(scopeAs('child', 'kid'), 'siblings', { value: 'pink' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(fact('siblings')?.value).toBe('blue');
  });

  it('refuses a child forgetting their sibling\'s memory', async () => {
    // The one the database permits: 0264 gates only medical and account, so
    // without this rule the row is simply gone.
    const res = await forgetFact(scopeAs('child', 'kid'), 'siblings', { kind: 'fact' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(fact('siblings')).toBeDefined();
  });

  it('lets a child edit their OWN memory', async () => {
    const res = await updateFact(scopeAs('child', 'kid'), 'mine', { value: 'red' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(fact('mine')?.value).toBe('red');
  });

  it('lets a parent edit anyone\'s', async () => {
    const res = await updateFact(scopeAs('parent', 'mum'), 'siblings', { value: 'yellow' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(fact('siblings')?.value).toBe('yellow');
  });

  it('will not reach another household at all', async () => {
    db.seed('family_facts', [{ id: 'theirs', family_id: 'family-2', member_id: 'x', category: 'preference', label: 'Cat name', value: 'Mo' }]);
    expect(await updateFact(scopeAs('parent', 'mum'), 'theirs', { value: 'Bo' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('family_facts').find((r) => r.id === 'theirs')?.value).toBe('Mo');
  });
});

describe('editing a memory', () => {
  it('renames in place rather than leaving two memories behind', async () => {
    // `rememberFact` upserts by KEY, so routing the editor there would have left
    // the old label behind as a second fact. `updateFact` is by id.
    const res = await updateFact(scopeAs('parent', 'mum'), 'mine', { label: 'Colour they like' });
    expect(res.ok).toBe(true);
    expect(db.table('family_facts').filter((r) => r.family_id === FAMILY)).toHaveLength(2);
    expect(fact('mine')?.label).toBe('Colour they like');
  });

  it('stops a child filing something as medical, which they could then not read', async () => {
    // 0264 gates medical and account rows to managers, so a member could
    // otherwise file a memory into a category that hides it from them.
    const res = await updateFact(scopeAs('child', 'kid'), 'mine', { category: 'medical' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(fact('mine')?.category).toBe('preference');
  });

  it('refuses an empty label or value rather than storing one', async () => {
    for (const patch of [{ label: '   ' }, { value: '  ' }]) {
      expect(await updateFact(scopeAs('parent', 'mum'), 'mine', patch)).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(fact('mine')?.label).toBe('Favourite colour');
  });

  it('records a pin as a pin, not as a generic edit', async () => {
    await updateFact(scopeAs('parent', 'mum'), 'mine', { pinned: true });
    expect(fact('mine')?.is_pinned).toBe(true);
    const row = db.table('audit_logs').at(-1);
    expect((row?.metadata as { title?: string })?.title).toBe('Pinned Favourite colour');
  });
});
