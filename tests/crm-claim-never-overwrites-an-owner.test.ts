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
 * the read's condition: the email the lookup verified and the owner it saw
 * (null for a claim). A write that matches nothing means the contact changed
 * since the read, so the sign-in's identity is `unknown`: no lifecycle-only
 * fallback, no visitor stitched to it and no consent carried to it (#1030).
 */
type Update = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };
let updates: Update[];
let inserts: string[];
let claimMatches: boolean;
let contactWriteMatches: boolean;

function fakeAdmin(ownerOnRead: string | null) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {};
    const settle = () => {
      if (patch) {
        updates.push({ table, patch, filters: { ...filters } });
        const isClaim = table === 'crm_contacts' && 'owner_id' in patch;
        // A claim matches only if nobody took the lead in between; any contact
        // write matches only if the row still says what the read saw.
        const lost = table === 'crm_contacts' && (!contactWriteMatches || (isClaim && !claimMatches));
        return { data: lost ? [] : [{ id: 'row' }], error: null };
      }
      if (table === 'crm_contacts') return { data: [{ id: 'contact-1', email: 'a@example.test', owner_id: ownerOnRead }], error: null };
      if (table === 'mkt_visitors') return { data: [{ id: 'visitor-1', contact_id: null }], error: null };
      return { data: null, error: null };
    };
    Object.assign(b, {
      select: () => b, limit: () => b,
      filter: (c: string, op: string, v: unknown) => { filters[`${op}:${c}`] = v; return b; },
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

beforeEach(() => {
  updates = [];
  inserts = [];
  claimMatches = true;
  contactWriteMatches = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const signIn = (owner: string | null) =>
  stitchVisitorIdentity(fakeAdmin(owner), { anonymousId: 'anon-1', email: 'a@example.test', userId: 'user-1' });

describe('claiming an unowned CRM contact (C1-S9-67)', () => {
  it('the claim repeats the read condition on the write', async () => {
    const result = await signIn(null);
    const claim = updates.find((u) => u.table === 'crm_contacts' && 'owner_id' in u.patch);
    expect(claim?.patch).toMatchObject({ owner_id: 'user-1', lifecycle_stage: 'customer' });
    expect(claim?.filters).toMatchObject({ id: 'contact-1', email: 'a@example.test', 'is:owner_id': null });
    // Positive control: a claim that lands goes on to stitch the visitor.
    expect(result).toEqual({ decision: 'link', contactId: 'contact-1' });
    expect(updates.some((u) => u.table === 'mkt_visitors')).toBe(true);
  });

  it('a claim that lost the race writes nothing further and links nothing', async () => {
    claimMatches = false;
    const result = await signIn(null);
    expect(result).toEqual({ decision: 'unknown', contactId: null });
    // The failed claim is the only write: no lifecycle-only fallback, no
    // visitor stitched, no consent carried, no replacement contact.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: 'crm_contacts', patch: { owner_id: 'user-1' } });
    expect(inserts).toEqual([]);
  });

  it('a contact that already has an owner is never claimed', async () => {
    const result = await signIn('someone-else');
    const contactWrites = updates.filter((u) => u.table === 'crm_contacts');
    expect(contactWrites).toHaveLength(1);
    expect(contactWrites[0].patch).toEqual({ lifecycle_stage: 'customer' });
    expect(contactWrites[0].filters).toMatchObject({ id: 'contact-1', email: 'a@example.test', owner_id: 'someone-else' });
    expect(result.contactId).toBe('contact-1');
  });

  it('an owned contact that changed before the stage write is unknown and links nothing', async () => {
    contactWriteMatches = false;
    const result = await signIn('someone-else');
    expect(result).toEqual({ decision: 'unknown', contactId: null });
    expect(updates.map((u) => u.table)).toEqual(['crm_contacts']);
    expect(inserts).toEqual([]);
  });
});
