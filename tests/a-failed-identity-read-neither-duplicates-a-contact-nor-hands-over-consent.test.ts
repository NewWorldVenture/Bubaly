// A failed read in the sign-in identity stitch is not an answer.
//
// `stitchVisitorIdentity` (lib/marketing/identity.ts) runs on every sign-in with
// the service role. It reads twice before it writes: crm_contacts by email
// ("is this person already a contact?") and mkt_visitors by the browser's
// anonymous id ("whose device is this?"). Both reads bound only `data`. A
// PostgREST call RESOLVES with { data: null, error } for a timeout, a 5xx or a
// dead connection — and the OAuth callback's transport turns every transport
// failure into exactly that 503 — so the try/catch around them never saw it,
// and a failed read looked exactly like an empty table:
//
//  - contact lookup failed → "no such contact" → INSERT a second contact for
//    the same address (crm_contacts has no unique key on email). The new id no
//    longer matches the one this device's visitor row carries, so the person's
//    own returning sign-in was decided a 'fork' — a stranger on a shared device
//    — and their anonymous id was rotated away.
//  - visitor lookup failed → "no visitor" → 'noop' → consent carried forward:
//    every still-unattributed consent row on the browser (whoever last answered
//    the banner on it) was stamped with the contact id of whoever signed in.
//
// `upsertOnboardingContact` had the same dropped-error lookups ahead of its
// INSERT, and so did the Settings page's progressive-profile nudge
// (app/(app)/dashboard/settings/profile-actions.ts `resolveContactId`, run on
// every Settings mount) — the third writer of crm_contacts rows, whose duplicate
// the sign-in stitch's email lookup can later pick.
// These tests drive the real functions over an in-memory database and
// make one read fail the two ways postgrest-js actually delivers a failure: an
// error, and the empty-bodied 404 it resolves with neither data nor error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';

// profile-actions.ts is a server-action module: it asks for the signed-in user
// and builds its own service client. Neither identity.ts nor
// onboarding-contact.ts imports these modules, so the mocks touch only it.
const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServiceClient: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
const { getProfileStateAction, saveProfileAnswerAction, skipProfileFieldAction } =
  await import('@/app/(app)/dashboard/settings/profile-actions');

type Outcome = 'ok' | 'error' | 'empty404' | 'throw';
type Admin = Parameters<typeof stitchVisitorIdentity>[0];

/** What postgrest-js resolves with (it never throws unless .throwOnError()). */
function replyFor(outcome: 'error' | 'empty404') {
  return outcome === 'error'
    ? { data: null, error: { message: 'Callback temporarily unavailable', code: '', details: '', hint: '' }, count: null, status: 503, statusText: '' }
    : { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
}

/** A query chain that has already failed: every modifier returns it, awaiting it yields the reply. */
function unanswered(outcome: 'error' | 'empty404'): unknown {
  const reply = replyFor(outcome);
  const chain: object = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(reply).then(onFulfilled, onRejected);
      }
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(reply);
      return () => chain;
    },
  });
  return chain;
}

/**
 * The in-memory database, with a script of outcomes for the READS of one table:
 * the nth `.from(table).select(...)` gets the nth outcome (then 'ok'); 'throw'
 * is a builder that throws instead of resolving. Writes —
 * including `.insert(...).select('id')` — always go through, which is the
 * partial failure that lands a duplicate: the read times out, the tiny write after
 * it does not.
 */
function withScriptedReads(db: InMemorySupabase, script: Record<string, Outcome[]>): Admin {
  const queues = new Map(Object.entries(script).map(([t, s]) => [t, [...s]]));
  const client = {
    from(table: string) {
      const builder = db.from(table);
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === 'select') {
            const next = queues.get(table)?.shift() ?? 'ok';
            if (next === 'throw') return () => { throw new Error('fetch failed'); };
            if (next !== 'ok') return () => unanswered(next);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return client as unknown as Admin;
}

const contactsFor = (db: InMemorySupabase, email: string) =>
  db.table('crm_contacts').filter((r) => String(r.email).toLowerCase() === email);
const row = (db: InMemorySupabase, table: string, id: string): Row | undefined =>
  db.table(table).find((r) => r.id === id);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });
const logged = (prefix: string) => errors.mock.calls.some((c: unknown[]) => String(c[0]).startsWith(prefix));

describe('a returning sign-in whose contact lookup fails', () => {
  function momsBrowser() {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom', lifecycle_stage: 'customer' }]);
    db.seed('mkt_visitors', [{ id: 'v-1', anonymous_id: 'vid-1', contact_id: 'c-mom' }]);
    return db;
  }

  it.each(['error', 'empty404'] as const)('does not create a second contact for her (%s)', async (outcome) => {
    const db = momsBrowser();
    const result = await stitchVisitorIdentity(withScriptedReads(db, { crm_contacts: [outcome] }),
      { anonymousId: 'vid-1', email: 'Mom@Example.test', userId: 'u-mom' });

    expect(contactsFor(db, 'mom@example.test').map((r) => r.id)).toEqual(['c-mom']);
    // Her own sign-in is not "a different person on this device": a 'fork'
    // makes both callers rotate her anonymous id and drop her spine. Exactly
    // 'unknown' — the old code answered 'fork' here (the duplicate's id is not
    // the one on v-1), and 'noop' would claim a decision no read supported.
    expect(result).toEqual({ decision: 'unknown', contactId: null });
    // An invariant, not the regression: no outcome of this stitch re-points her spine.
    expect(row(db, 'mkt_visitors', 'v-1')?.contact_id).toBe('c-mom');
    // And the operator can see why nothing happened.
    expect(logged('[identity] contact lookup failed')).toBe(true);
  });

  it('control: when the lookup answers, her existing contact is reused and her device stays hers', async () => {
    const db = momsBrowser();
    const result = await stitchVisitorIdentity(withScriptedReads(db, {}),
      { anonymousId: 'vid-1', email: 'mom@example.test', userId: 'u-mom' });
    expect(contactsFor(db, 'mom@example.test').map((r) => r.id)).toEqual(['c-mom']);
    expect(result).toEqual({ decision: 'noop', contactId: 'c-mom' });
  });

  it('control: a first sign-up still creates exactly one contact and links the device to it', async () => {
    const db = createInMemorySupabase();
    db.seed('mkt_visitors', [{ id: 'v-new', anonymous_id: 'vid-new', contact_id: null }]);
    const result = await stitchVisitorIdentity(withScriptedReads(db, {}),
      { anonymousId: 'vid-new', email: 'new@example.test', userId: 'u-new' });
    const created = contactsFor(db, 'new@example.test');
    expect(created).toHaveLength(1);
    expect(result).toEqual({ decision: 'link', contactId: created[0].id });
    expect(row(db, 'mkt_visitors', 'v-new')?.contact_id).toBe(created[0].id);
  });
});

describe("Dad signs in on Mom's browser and the visitor lookup fails", () => {
  // Mom's sign-in linked this browser's spine to her. After she signed out she
  // answered the banner again on the same browser — opting into marketing email —
  // and that row is written unattributed, like every banner write.
  function sharedBrowser() {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [
      { id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom' },
      { id: 'c-dad', email: 'dad@example.test', owner_id: 'u-dad' },
    ]);
    db.seed('mkt_visitors', [{ id: 'v-shared', anonymous_id: 'vid-shared', contact_id: 'c-mom' }]);
    db.seed('mkt_consent_events', [
      { id: 'e-mom-signed-in', anonymous_id: 'vid-shared', category: 'analytics', decision: 'granted', contact_id: 'c-mom' },
      { id: 'e-mom-after-signout', anonymous_id: 'vid-shared', category: 'marketing_email', decision: 'granted', contact_id: null },
    ]);
    return db;
  }
  const dad = { anonymousId: 'vid-shared', email: 'dad@example.test', userId: 'u-dad' };

  // 'throw' is the stitch's own catch: a read that never resolved leaves the
  // decision where it was seeded, and that seed must not be one that carries.
  it.each(['error', 'empty404', 'throw'] as const)('does not record a marketing opt-in Dad never gave (%s)', async (outcome) => {
    const db = sharedBrowser();
    await stitchVisitorIdentity(withScriptedReads(db, { mkt_visitors: [outcome] }), dad);

    const dads = db.table('mkt_consent_events').filter((r) => r.contact_id === 'c-dad');
    expect(dads, 'consent rows now attributed to Dad').toEqual([]);
    expect(row(db, 'mkt_consent_events', 'e-mom-after-signout')?.contact_id).toBeNull();
    expect(row(db, 'mkt_consent_events', 'e-mom-signed-in')?.contact_id).toBe('c-mom');
    // Mom's spine is not re-pointed either.
    expect(row(db, 'mkt_visitors', 'v-shared')?.contact_id).toBe('c-mom');
    expect(logged('[identity] visitor')).toBe(true);
  });

  it('reports the stitch as undecided rather than "nothing to do"', async () => {
    const db = sharedBrowser();
    const result = await stitchVisitorIdentity(withScriptedReads(db, { mkt_visitors: ['error'] }), dad);
    expect(result).toEqual({ decision: 'unknown', contactId: 'c-dad' });
  });

  it('control: when the lookup answers, the shared device is a fork and nothing is carried', async () => {
    const db = sharedBrowser();
    const result = await stitchVisitorIdentity(withScriptedReads(db, {}), dad);
    expect(result.decision).toBe('fork');
    expect(db.table('mkt_consent_events').filter((r) => r.contact_id === 'c-dad')).toEqual([]);
  });

  it("control: the same person's own unattributed consent is still carried forward", async () => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom' }]);
    db.seed('mkt_visitors', [{ id: 'v-mine', anonymous_id: 'vid-mine', contact_id: null }]);
    db.seed('mkt_consent_events', [
      { id: 'e-before-signup', anonymous_id: 'vid-mine', category: 'analytics', decision: 'granted', contact_id: null },
    ]);
    const result = await stitchVisitorIdentity(withScriptedReads(db, {}),
      { anonymousId: 'vid-mine', email: 'mom@example.test', userId: 'u-mom' });
    expect(result.decision).toBe('link');
    expect(row(db, 'mkt_consent_events', 'e-before-signup')?.contact_id).toBe('c-mom');
  });
});

describe('onboarding enriches the contact it could not find', () => {
  // The sign-up stitch created Mom's contact with no family. Onboarding then
  // looks her up by email to attach the household.
  it.each(['error', 'empty404'] as const)('does not insert a second contact when the email lookup fails (%s)', async (outcome) => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', family_id: null, lead_source: 'signup' }]);
    await upsertOnboardingContact(withScriptedReads(db, { crm_contacts: [outcome] }),
      { userId: 'u-mom', email: 'mom@example.test', familyId: 'f-1', firstName: 'Mom' });
    expect(contactsFor(db, 'mom@example.test').map((r) => r.id)).toEqual(['c-mom']);
    expect(logged('[onboarding-contact] contact lookup by email failed')).toBe(true);
  });

  it('does not insert a second contact for the household when the family lookup fails', async () => {
    const db = createInMemorySupabase();
    // An operator already added this household under the shared address.
    db.seed('crm_contacts', [{ id: 'c-home', email: 'home@example.test', family_id: 'f-1', lead_source: 'admin' }]);
    await upsertOnboardingContact(withScriptedReads(db, { crm_contacts: ['ok', 'error'] }),
      { userId: 'u-mom', email: 'mom@example.test', familyId: 'f-1', firstName: 'Mom' });
    expect(db.table('crm_contacts').filter((r) => r.family_id === 'f-1').map((r) => r.id)).toEqual(['c-home']);
    expect(logged('[onboarding-contact] contact lookup by family failed')).toBe(true);
  });

  it('control: when the lookup answers, the existing contact is enriched in place', async () => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', family_id: null, lead_source: 'signup' }]);
    await upsertOnboardingContact(withScriptedReads(db, {}),
      { userId: 'u-mom', email: 'mom@example.test', familyId: 'f-1', firstName: 'Mom' });
    expect(db.table('crm_contacts')).toHaveLength(1);
    expect(row(db, 'crm_contacts', 'c-mom')).toMatchObject({ family_id: 'f-1', first_name: 'Mom' });
  });
});

/** The same client, except every upsert on `table` resolves the way a refused write does. */
function refusingUpserts(client: Admin, table: string): Admin {
  const inner = client as unknown as { from(t: string): object };
  return {
    from(t: string) {
      const builder = inner.from(t);
      if (t !== table) return builder;
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === 'upsert') return () => Promise.resolve(replyFor('error'));
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Admin;
}

describe('the Settings profile nudge resolves a contact it could not look up', () => {
  const mom = { user: { id: 'u-mom', email: 'mom@example.test' } };
  beforeEach(() => { mocks.requireUserContext.mockResolvedValue(mom); });
  const serve = (admin: Admin) => mocks.createServiceClient.mockReturnValue(admin);

  it.each(['error', 'empty404'] as const)('does not create a second contact when the email lookup fails (%s)', async (outcome) => {
    // An operator added her before she signed up, so no contact is owned yet
    // and the email lookup is what finds hers.
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'Mom@Example.test', owner_id: null, lead_source: 'admin' }]);
    serve(withScriptedReads(db, { crm_contacts: ['ok', outcome] }));

    await expect(getProfileStateAction()).rejects.toThrow();
    expect(contactsFor(db, 'mom@example.test').map((r) => r.id)).toEqual(['c-mom']);
    expect(logged('[profile-actions] contact lookup by email failed')).toBe(true);
  });

  it('does not create a second contact when the owner lookup fails for a changed address', async () => {
    // Her contact is owned by her account but still carries the address she
    // signed up with; only the owner lookup can find it.
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'old-mom@example.test', owner_id: 'u-mom' }]);
    serve(withScriptedReads(db, { crm_contacts: ['error'] }));

    await expect(getProfileStateAction()).rejects.toThrow();
    expect(db.table('crm_contacts').filter((r) => r.owner_id === 'u-mom').map((r) => r.id)).toEqual(['c-mom']);
    expect(logged('[profile-actions] contact lookup by owner failed')).toBe(true);
  });

  // 'empty404' is the shape a `.maybeSingle()` read would have taken for "no
  // profile yet" (data=null, error=null) — the re-review showed it overwriting
  // the dismissed questions until the read became an array.
  it.each(['error', 'empty404'] as const)('a skip on a profile it could not read keeps the questions she already dismissed (%s)', async (outcome) => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom' }]);
    db.seed('crm_contact_profile', [{ id: 'p-mom', contact_id: 'c-mom', extra: { skipped: ['role'] } }]);
    serve(withScriptedReads(db, { crm_contact_profile: [outcome] }));

    await expect(skipProfileFieldAction('top_priority')).rejects.toThrow();
    expect(row(db, 'crm_contact_profile', 'p-mom')?.extra).toEqual({ skipped: ['role'] });
  });

  it.each([
    ['skip', () => skipProfileFieldAction('top_priority')],
    ['save', () => saveProfileAnswerAction('role', 'parent')],
  ] as const)('a %s whose write is refused rejects instead of returning a state it did not store', async (_name, act) => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom' }]);
    serve(refusingUpserts(withScriptedReads(db, {}), 'crm_contact_profile'));

    await expect(act()).rejects.toThrow();
    expect(db.table('crm_contact_profile')).toEqual([]);
  });

  it('control: when the lookups answer, her unowned contact is claimed, not duplicated', async () => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'Mom@Example.test', owner_id: null, lead_source: 'admin' }]);
    serve(withScriptedReads(db, {}));

    await expect(getProfileStateAction()).resolves.toEqual({ known: {}, skipped: [] });
    expect(contactsFor(db, 'mom@example.test').map((r) => r.id)).toEqual(['c-mom']);
    expect(row(db, 'crm_contacts', 'c-mom')?.owner_id).toBe('u-mom');
  });

  it('control: a skip that lands adds to what she already dismissed', async () => {
    const db = createInMemorySupabase();
    db.seed('crm_contacts', [{ id: 'c-mom', email: 'mom@example.test', owner_id: 'u-mom' }]);
    db.seed('crm_contact_profile', [{ id: 'p-mom', contact_id: 'c-mom', extra: { skipped: ['role'] } }]);
    serve(withScriptedReads(db, {}));

    await expect(skipProfileFieldAction('top_priority')).resolves.toMatchObject({ skipped: ['role', 'top_priority'] });
    expect(row(db, 'crm_contact_profile', 'p-mom')?.extra).toEqual({ skipped: ['role', 'top_priority'] });
  });
});
