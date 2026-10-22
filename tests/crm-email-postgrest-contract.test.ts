// Allocated synthetic native CRM contract: real SDK/HTTP/PostgREST/PG, no provider calls.
import { appendFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
const h = vi.hoisted(() => ({ db: null as unknown, email: 'p*q@example.com', userId: 'actor' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: h.userId, email: h.email } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';
import { getProfileStateAction, saveProfileAnswerAction, skipProfileFieldAction } from '@/app/(app)/dashboard/settings/profile-actions';
import { literalCaseInsensitivePattern } from '@/lib/supabase/escape-like';
const nativeUrl = process.env.BUBALY_CRM_NATIVE_URL;
const native = nativeUrl ? describe : describe.skip;
let db: PostgrestClient;
let afterRead: (() => Promise<void>) | null = null;
const client = () => {
  if (!nativeUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(nativeUrl)) throw new Error('Owned loopback URL required');
  return new PostgrestClient(nativeUrl, { fetch: async (input, init) => {
    const response = await fetch(input, init);
    const method = init?.method ?? 'GET', url = String(input);
    if (process.env.BUBALY_CRM_HTTP_LOG) appendFileSync(process.env.BUBALY_CRM_HTTP_LOG, JSON.stringify({ method, url, status: response.status, body: init?.body, response: await response.clone().text() }) + '\n');
    if (afterRead && method === 'GET' && url.includes('crm_contacts') && (url.includes('ilike.') || url.includes('imatch.') || url.includes('family_id=eq.'))) { const work = afterRead; afterRead = null; await work(); }
    return response;
  } });
};
const rows = async (table: string) => { const r = await db.from(table).select('*'); expect(r.error).toBeNull(); return r.data ?? []; };
const seed = async (table: string, data: Record<string, unknown>[]) => { const r = await db.from(table).insert(data); expect(r.error).toBeNull(); };
const capture = async (name: string, result: unknown) => {
  const state = { name, result, contacts: await rows('crm_contacts'), visitors: await rows('mkt_visitors'), consent: await rows('mkt_consent_events'), profiles: await rows('crm_contact_profile') };
  if (process.env.BUBALY_CRM_OBSERVATIONS) appendFileSync(process.env.BUBALY_CRM_OBSERVATIONS, JSON.stringify(state) + '\n');
  return state;
};
beforeEach(async () => {
  if (!nativeUrl) return;
  afterRead = null; h.email = 'p*q@example.com'; h.userId = 'actor'; db = client(); h.db = db;
  for (const table of ['crm_contact_profile', 'mkt_consent_events', 'mkt_visitors', 'crm_contacts']) { const r = await db.from(table).delete().neq('id', ''); expect(r.error).toBeNull(); }
});
native('CRM email identity never follows a different PostgREST pattern match', () => {
  it('identity literal-star address does not claim the percent-address contact or carry consent to it', async () => {
    await seed('crm_contacts', [{ id: 'foreign', email: 'p%q@example.com', owner_id: null, family_id: 'foreign-family' }]);
    await seed('mkt_visitors', [{ id: 'visitor', anonymous_id: 'synthetic-visitor', contact_id: null }]);
    await seed('mkt_consent_events', [{ id: 'consent', anonymous_id: 'synthetic-visitor', contact_id: null }]);
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId });
    const state = await capture('identity-star', result);
    expect(state.contacts.find(r => r.id === 'foreign')?.owner_id).toBeNull();
    expect(state.visitors[0]?.contact_id).not.toBe('foreign'); expect(state.consent[0]?.contact_id).not.toBe('foreign');
  });
  it('onboarding literal-star address leaves a foreign-owned percent-address contact intact', async () => {
    await seed('crm_contacts', [{ id: 'foreign', email: 'p%q@example.com', owner_id: 'foreign-owner', family_id: 'foreign-family', first_name: 'Foreign', notes: 'Private' }]);
    await upsertOnboardingContact(db as never, { userId: h.userId, email: h.email, familyId: 'actor-family', firstName: 'Actor' });
    const state = await capture('onboarding-star', null);
    expect(state.contacts.find(r => r.id === 'foreign')).toMatchObject({ email: 'p%q@example.com', family_id: 'foreign-family', first_name: 'Foreign', notes: 'Private' });
  });
  it('profile literal-star fallback does not claim or disclose a percent-address profile', async () => {
    await seed('crm_contacts', [{ id: 'foreign', email: 'p%q@example.com', owner_id: null }]);
    await seed('crm_contact_profile', [{ id: 'profile', contact_id: 'foreign', role: 'parent', top_priority: 'Foreign private answer' }]);
    const result = await getProfileStateAction(); const state = await capture('profile-star', result);
    expect(state.contacts.find(r => r.id === 'foreign')?.owner_id).toBeNull(); expect(result.known.top_priority).not.toBe('Foreign private answer');
  });
  it('legitimate mixed-case identity match claims and links only the exact address', async () => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'correct', email: 'Reader@Example.COM', owner_id: null }]);
    await seed('mkt_visitors', [{ id: 'visitor', anonymous_id: 'synthetic-visitor', contact_id: null }]);
    await seed('mkt_consent_events', [{ id: 'consent', anonymous_id: 'synthetic-visitor', contact_id: null }]);
    expect(await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId })).toEqual({ decision: 'link', contactId: 'correct' });
    const state = await capture('identity-positive', null); expect(state.contacts[0]?.owner_id).toBe('actor'); expect(state.consent[0]?.contact_id).toBe('correct');
  });
  it('legitimate onboarding exact match updates the intended existing contact', async () => {
    await seed('crm_contacts', [{ id: 'correct', email: 'Reader@Example.COM', owner_id: 'actor', family_id: 'actor-family' }]);
    await upsertOnboardingContact(db as never, { userId: h.userId, email: 'reader@example.com', familyId: 'actor-family', firstName: 'Actor' });
    const state = await capture('onboarding-positive', null); expect(state.contacts).toHaveLength(1); expect(state.contacts[0]).toMatchObject({ id: 'correct', first_name: 'Actor', email: 'reader@example.com' });
  });
  it('legitimate profile owned contact returns only its saved answer', async () => {
    await seed('crm_contacts', [{ id: 'correct', email: h.email, owner_id: 'actor' }]); await seed('crm_contact_profile', [{ id: 'profile', contact_id: 'correct', role: 'parent' }]);
    expect((await getProfileStateAction()).known.role).toBe('parent'); await capture('profile-positive', null);
  });
  it('real native schema-query refusal does not create or stitch a contact', async () => {
    const result = await stitchVisitorIdentity(db.schema('unexposed_crm') as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId });
    expect(result).toEqual({ decision: 'unknown', contactId: null }); const state = await capture('query-refusal', result); expect(state.contacts).toEqual([]);
  });
  it('email retarget committed after the read cannot be claimed as the old identity', async () => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'retarget', email: h.email, owner_id: null }]);
    afterRead = async () => { const r = await new PostgrestClient(nativeUrl!).from('crm_contacts').update({ email: 'foreign@example.com' }).eq('id', 'retarget'); expect(r.error).toBeNull(); };
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId });
    const state = await capture('email-retarget-race', result); expect(state.contacts.find(r => r.id === 'retarget')?.owner_id).toBeNull();
  });
  it.each(['p%q', 'p_q', 'p\\q', 'p*q', 'p^$.*+?()[]{}|\\q'])('native exact regex preserves %s beside 501 neighbouring contacts', async (local) => {
    h.email = `${local}@example.com`;
    await seed('crm_contacts', Array.from({ length: 501 }, (_, i) => ({ id: `neighbour-${i}`, email: `${local}x${i}@example.com`, owner_id: 'foreign-owner' })));
    await seed('crm_contacts', [{ id: 'correct', email: `${local}@Example.COM`, owner_id: null }]);
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId });
    expect(result.contactId).toBe('correct'); const state = await capture(`literal-${local}`, result);
    expect(state.contacts.find(r => r.id === 'correct')?.owner_id).toBe('actor'); expect(state.contacts.filter(r => r.owner_id === 'foreign-owner')).toHaveLength(501);
    const exact = await db.from('crm_contacts').select('id').filter('email', 'imatch', literalCaseInsensitivePattern(h.email));
    expect(exact.error).toBeNull(); expect(exact.data).toEqual([{ id: 'correct' }]);
  });
  it('legitimate literal-star email works alongside the previously dangerous percent contact', async () => {
    await seed('crm_contacts', [{ id: 'percent', email: 'p%q@example.com', owner_id: null }, { id: 'star', email: h.email, owner_id: null }]);
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId });
    expect(result.contactId).toBe('star'); const state = await capture('star-percent-neighbours', result); expect(state.contacts.find(r => r.id === 'percent')?.owner_id).toBeNull();
  });
  it.each(['save', 'skip'])('profile %s leaves the percent-address profile untouched', async (action) => {
    await seed('crm_contacts', [{ id: 'foreign', email: 'p%q@example.com', owner_id: null }]);
    await seed('crm_contact_profile', [{ id: 'foreign-profile', contact_id: 'foreign', role: 'parent', extra: { skipped: ['interests'] } }]);
    const result = action === 'save' ? await saveProfileAnswerAction('role', 'parent') : await skipProfileFieldAction('role');
    const state = await capture(`profile-${action}`, result); expect(state.contacts.find(r => r.id === 'foreign')?.owner_id).toBeNull();
    expect(state.profiles.find(r => r.id === 'foreign-profile')).toMatchObject({ role: 'parent', extra: { skipped: ['interests'] } });
    const actor = state.contacts.find(r => r.owner_id === 'actor'); expect(actor?.email).toBe(h.email); expect(state.profiles.some(r => r.contact_id === actor?.id)).toBe(true);
  });
  it.each(['email', 'owner_id'])('profile claim refuses a real %s retarget and reads no foreign answer', async (field) => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'retarget', email: h.email, owner_id: null }]); await seed('crm_contact_profile', [{ id: 'profile', contact_id: 'retarget', top_priority: 'Foreign private answer' }]);
    afterRead = async () => { const r = await new PostgrestClient(nativeUrl!).from('crm_contacts').update({ [field]: field === 'email' ? 'foreign@example.com' : 'foreign-owner' }).eq('id', 'retarget'); expect(r.error).toBeNull(); };
    await expect(getProfileStateAction()).rejects.toThrow(); const state = await capture(`profile-${field}-retarget`, null); expect(state.contacts.find(r => r.id === 'retarget')?.owner_id).not.toBe('actor');
    expect(state.profiles[0]?.top_priority).toBe('Foreign private answer'); expect(state.contacts).toHaveLength(1);
  });
  it('identity owner acquisition after the read never carries visitor or consent to that contact', async () => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'retarget', email: h.email, owner_id: null }]);
    await seed('mkt_visitors', [{ id: 'visitor', anonymous_id: 'synthetic-visitor', contact_id: null }]); await seed('mkt_consent_events', [{ id: 'consent', anonymous_id: 'synthetic-visitor', contact_id: null }]);
    afterRead = async () => { const r = await new PostgrestClient(nativeUrl!).from('crm_contacts').update({ owner_id: 'foreign-owner' }).eq('id', 'retarget'); expect(r.error).toBeNull(); };
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId }); expect(result.decision).toBe('unknown');
    const state = await capture('identity-owner-retarget', result); expect(state.visitors[0]?.contact_id).toBeNull(); expect(state.consent[0]?.contact_id).toBeNull(); expect(state.contacts[0]?.lifecycle_stage).toBeNull();
  });
  it.each(['email', 'owner_id', 'family_id'])('onboarding refuses a real %s retarget before the privileged update', async (field) => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'retarget', email: h.email, owner_id: 'actor', family_id: 'actor-family', first_name: 'Before' }]);
    afterRead = async () => { const r = await new PostgrestClient(nativeUrl!).from('crm_contacts').update({ [field]: `foreign-${field}` }).eq('id', 'retarget'); expect(r.error).toBeNull(); };
    await upsertOnboardingContact(db as never, { userId: h.userId, email: h.email, familyId: 'actor-family', firstName: 'After' });
    const state = await capture(`onboarding-${field}-retarget`, null); expect(state.contacts).toHaveLength(1); expect(state.contacts[0]?.first_name).toBe('Before'); expect(state.contacts[0]?.[field]).toBe(`foreign-${field}`);
  });
  it('onboarding family fallback is fenced against a family move after its read', async () => {
    await seed('crm_contacts', [{ id: 'retarget', email: 'old@example.com', owner_id: 'actor', family_id: 'actor-family', first_name: 'Before' }]);
    afterRead = async () => { const r = await new PostgrestClient(nativeUrl!).from('crm_contacts').update({ family_id: 'foreign-family' }).eq('id', 'retarget'); expect(r.error).toBeNull(); };
    // A null email reaches the existing family fallback directly.
    await upsertOnboardingContact(db as never, { userId: h.userId, email: null, familyId: 'actor-family', firstName: 'After' });
    const state = await capture('onboarding-family-fallback-retarget', null); expect(state.contacts[0]).toMatchObject({ family_id: 'foreign-family', first_name: 'Before', email: 'old@example.com' });
  });
  it('onboarding and profile still refuse actual unexposed-schema query errors', async () => {
    const invalid = db.schema('unexposed_crm'); await upsertOnboardingContact(invalid as never, { userId: h.userId, email: h.email }); h.db = invalid;
    await expect(getProfileStateAction()).rejects.toThrow(); const state = await capture('all-query-refusal', null); expect(state.contacts).toEqual([]); expect(state.profiles).toEqual([]);
  });
  it('retains the existing limit-one duplicate exact-contact policy without matching neighbours', async () => {
    h.email = 'reader@example.com'; await seed('crm_contacts', [{ id: 'duplicate-a', email: h.email, owner_id: null }, { id: 'duplicate-b', email: 'Reader@Example.COM', owner_id: null }, { id: 'neighbour', email: 'readerx@example.com', owner_id: null }]);
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: h.email, userId: h.userId }); expect(['duplicate-a', 'duplicate-b']).toContain(result.contactId);
    const state = await capture('duplicate-policy', result); expect(state.contacts.filter(r => r.owner_id === 'actor')).toHaveLength(1); expect(state.contacts.find(r => r.id === 'neighbour')?.owner_id).toBeNull();
  });
});
