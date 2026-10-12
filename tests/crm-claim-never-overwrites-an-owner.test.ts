import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { stitchVisitorIdentity } = await import('@/lib/marketing/identity');

/**
 * Audit C1-S9-67 — the CRM contact claim in `stitchVisitorIdentity` never
 * overwrites an owner.
 *
 * The read saw `owner_id` null and the write set it, filtered on `id` alone —
 * so a lead claimed in between (an import, another sign-in) was overwritten.
 * C1-S9-61 closed the same race in `resolveContactId`. The write now repeats
 * the raw identity and read's condition. A lost claim is unknown: no later
 * contact fallback, visitor link or consent carry may use that stale answer.
 */
type Update = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };
let updates: Update[];
let inserts: string[];
let lookups: { table: string; column: string; operator: string; value: unknown }[];
let claimMatches: boolean;

function fakeAdmin(ownerOnRead: string | null) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {};
    const settle = () => {
      if (patch) {
        updates.push({ table, patch, filters: { ...filters } });
        const isClaim = table === 'crm_contacts' && 'owner_id' in patch;
        // A claim matches only if nobody took the lead in between.
        const rows = isClaim && !claimMatches ? [] : [{ id: 'row' }];
        return { data: rows, error: null };
      }
      if (table === 'crm_contacts') return { data: [{ id: 'contact-1', email: 'a@example.test', owner_id: ownerOnRead }], error: null };
      return { data: [], error: null };
    };
    Object.assign(b, {
      select: () => b, ilike: () => b, limit: () => b,
      filter: (c: string, op: string, value: unknown) => {
        if (op !== 'imatch') throw new Error('Unexpected contact identity operator');
        lookups.push({ table, column: c, operator: op, value }); return b;
      },
      eq: (c: string, v: unknown) => { filters[c] = v; return b; },
      is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return b; },
      update: (p: Record<string, unknown>) => { patch = p; return b; },
      insert: () => { inserts.push(table); return b; },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    });
    return b;
  };
  return { from } as never;
}

beforeEach(() => { updates = []; inserts = []; lookups = []; claimMatches = true; vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('claiming an unowned CRM contact (C1-S9-67)', () => {
  it('the claim repeats the read condition on the write', async () => {
    const result = await stitchVisitorIdentity(fakeAdmin(null), { anonymousId: 'anon-1', email: 'a@example.test', userId: 'user-1' });
    const claim = updates.find((u) => u.table === 'crm_contacts' && 'owner_id' in u.patch);
    expect(claim?.patch).toMatchObject({ owner_id: 'user-1', lifecycle_stage: 'customer' });
    expect(claim?.filters).toMatchObject({ id: 'contact-1', email: 'a@example.test', 'is:owner_id': null });
    expect(lookups).toEqual([{ table: 'crm_contacts', column: 'email', operator: 'imatch', value: '^a@example\\.test$' }]);
    expect(result).toEqual({ decision: 'noop', contactId: 'contact-1' });
    expect(updates.filter(u => u.table === 'mkt_consent_events')).toHaveLength(1);
  });

  it('a claim that lost the race stops as unknown without another contact, visitor or consent write', async () => {
    claimMatches = false;
    const result = await stitchVisitorIdentity(fakeAdmin(null), { anonymousId: 'anon-1', email: 'a@example.test', userId: 'user-1' });
    const contactWrites = updates.filter((u) => u.table === 'crm_contacts');
    // One attempted CAS returns zero rows; there must be no fallback write.
    expect(contactWrites.filter((u) => 'owner_id' in u.patch)).toHaveLength(1);
    expect(contactWrites).toHaveLength(1);
    expect(contactWrites[0].filters).toMatchObject({ id: 'contact-1', email: 'a@example.test', 'is:owner_id': null });
    expect(updates.filter(u => u.table !== 'crm_contacts')).toEqual([]);
    expect(inserts).toEqual([]);
    expect(result).toEqual({ decision: 'unknown', contactId: null });
  });

  it('a contact that already has an owner is never claimed', async () => {
    await stitchVisitorIdentity(fakeAdmin('someone-else'), { anonymousId: 'anon-1', email: 'a@example.test', userId: 'user-1' });
    const contactWrites = updates.filter((u) => u.table === 'crm_contacts');
    expect(contactWrites).toHaveLength(1);
    expect(contactWrites.every((u) => !('owner_id' in u.patch))).toBe(true);
    expect(contactWrites[0].filters).toMatchObject({ id: 'contact-1', email: 'a@example.test', owner_id: 'someone-else' });
  });
});
