import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

/**
 * A suggestion in the review inbox is one row for the whole household, and a
 * dismissal is permanent: the playbook refresh never re-offers a dismissed
 * signature. Accepting one has always been a manager's call (`confirmFact`),
 * and the Needs-you card refuses a child both ways ("Kids and guests see the
 * same list read-only"). Dismissing was not gated anywhere else:
 * `forgetFact(..., { kind: 'suggestion' })` had no role check, and the
 * playbook page's Dismiss wrote the row itself with none either — so a child
 * could make a pattern a parent never saw disappear for good.
 * (SRV-001 census, SRV-C02.)
 */

const state = vi.hoisted(() => ({ role: 'child' as string, writes: [] as { table: string; payload: unknown }[] }));

function makeDb() {
  const from = (table: string) => {
    let kind = 'select';
    let payload: unknown;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: chain, is: chain, in: chain, order: chain, limit: chain,
      update: (p: unknown) => { kind = 'update'; payload = p; return b; },
      maybeSingle: () => {
        if (kind === 'update') state.writes.push({ table, payload });
        return Promise.resolve({ data: kind === 'update' ? { id: 'sug-1', label: 'Go-to dinner' } : null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (kind === 'update') state.writes.push({ table, payload });
        return Promise.resolve({ data: kind === 'update' ? [{ id: 'sug-1' }] : [], error: null }).then(resolve);
      },
    });
    return b;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => makeDb() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: state.role, member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { forgetFact } = await import('@/lib/services/memory');
const { dismissSuggestionAction } = await import('@/app/(app)/dashboard/playbook/playbook-actions');

function scope(role: string): ServiceScope {
  return {
    db: makeDb(), familyId: 'fam-1', userId: 'user-1', memberId: 'member-1', role,
    actorKind: 'member', tz: 'UTC', now: new Date('2026-09-27T12:00:00Z'),
  } as ServiceScope;
}

beforeEach(() => { state.writes = []; state.role = 'child'; });

describe('only a parent or adult dismisses what Bubaly noticed', () => {
  it.each(['child', 'teen', 'guest'])('the service refuses a %s and writes nothing', async (role) => {
    const res = await forgetFact(scope(role), 'sug-1', { kind: 'suggestion' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(state.writes).toEqual([]);
  });

  it.each(['parent', 'adult'])('the service still dismisses for a %s', async (role) => {
    const res = await forgetFact(scope(role), 'sug-1', { kind: 'suggestion' });
    expect(res).toMatchObject({ ok: true, data: { kind: 'suggestion' } });
    expect(state.writes).toEqual([{ table: 'family_playbook_suggestions', payload: { status: 'dismissed' } }]);
  });

  it('the playbook page’s Dismiss refuses a child and writes nothing', async () => {
    state.role = 'child';
    const res = await dismissSuggestionAction({ id: 'sug-1' });
    expect(res.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it('the playbook page’s Dismiss still works for a parent', async () => {
    state.role = 'parent';
    const res = await dismissSuggestionAction({ id: 'sug-1' });
    expect(res).toEqual({ ok: true });
    expect(state.writes).toHaveLength(1);
  });
});
