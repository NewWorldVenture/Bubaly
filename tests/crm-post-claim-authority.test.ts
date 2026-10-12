// Allocated two-case native probe: real SDK/HTTP/PostgREST/PG, no provider calls.
import { appendFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';

const nativeUrl = process.env.BUBALY_CRM_NATIVE_URL;
const native = nativeUrl ? describe : describe.skip;
let db: PostgrestClient;
let race = false;
let competingCommits = 0;
let refuseVisitorPatch = false;
let refusedPatches = 0;
const observe = (name: string, value: unknown) => {
  if (process.env.BUBALY_CRM_OBSERVATIONS) appendFileSync(process.env.BUBALY_CRM_OBSERVATIONS, JSON.stringify({ name, value }) + '\n');
};
const rows = async (table: string) => {
  const result = await db.from(table).select('*');
  expect(result.error).toBeNull();
  return result.data ?? [];
};

beforeEach(async () => {
  if (!nativeUrl) return;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(nativeUrl)) throw new Error('Owned loopback URL required');
  race = false; competingCommits = 0; refuseVisitorPatch = false; refusedPatches = 0;
  db = new PostgrestClient(nativeUrl, { fetch: async (input, init) => {
    const method = init?.method ?? 'GET', url = String(input);
    let actualInit = init;
    if (refuseVisitorPatch && method === 'PATCH' && url.includes('/mkt_visitors?')) {
      const headers = new Headers(init?.headers);
      headers.set('Content-Profile', 'visitor_probe_unexposed');
      actualInit = { ...init, headers };
      refusedPatches += 1;
    }
    // The fault is a real unexposed-schema request, not a substituted response.
    const response = await fetch(input, actualInit);
    if (refuseVisitorPatch && method === 'PATCH' && url.includes('/mkt_visitors?')) {
      const error = await response.clone().json();
      expect(response.status).toBe(406);
      expect(error.code).toBe('PGRST106');
      observe('actual-unexposed-schema-patch-refusal', { status: response.status, error, contentProfile: new Headers(actualInit?.headers).get('Content-Profile') });
    }
    if (process.env.BUBALY_CRM_HTTP_LOG) appendFileSync(process.env.BUBALY_CRM_HTTP_LOG, JSON.stringify({ method, url, status: response.status, body: init?.body, response: await response.clone().text() }) + '\n');
    if (race && method === 'GET' && url.includes('/mkt_visitors?') && url.includes('anonymous_id=eq.synthetic-visitor')) {
      race = false;
      // The real GET has completed; the caller has not consumed its old answer.
      // A second real SDK transaction now commits the other person's binding.
      const commit = await new PostgrestClient(nativeUrl!).from('mkt_visitors')
        .update({ contact_id: 'foreign' }).eq('id', 'visitor').is('contact_id', null).select('id,contact_id');
      expect(commit.error).toBeNull();
      expect(commit.data).toEqual([{ id: 'visitor', contact_id: 'foreign' }]);
      competingCommits += 1;
      observe('competing-visitor-claim', commit.data);
    }
    return response;
  } });
  for (const table of ['crm_contact_profile', 'mkt_consent_events', 'mkt_visitors', 'crm_contacts']) {
    expect((await db.from(table).delete().neq('id', '')).error).toBeNull();
  }
  expect((await db.from('crm_contacts').insert([
    { id: 'correct', email: 'Reader@Example.COM', owner_id: null },
    { id: 'foreign', email: 'foreign@example.com', owner_id: 'foreign-owner' },
  ])).error).toBeNull();
  expect((await db.from('mkt_visitors').insert({ id: 'visitor', anonymous_id: 'synthetic-visitor', contact_id: null })).error).toBeNull();
  expect((await db.from('mkt_consent_events').insert({ id: 'consent', anonymous_id: 'synthetic-visitor', contact_id: null })).error).toBeNull();
});

native('visitor authority after the contact identity CAS succeeds', () => {
  it('healthy contact claim links its unclaimed visitor and carries its consent', async () => {
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: 'reader@example.com', userId: 'actor' });
    const state = { result, contacts: await rows('crm_contacts'), visitors: await rows('mkt_visitors'), consent: await rows('mkt_consent_events') };
    observe('healthy-final', state);
    expect(result).toEqual({ decision: 'link', contactId: 'correct' });
    expect(state.contacts.find(row => row.id === 'correct')?.owner_id).toBe('actor');
    expect(state.visitors[0]?.contact_id).toBe('correct');
    expect(state.consent[0]?.contact_id).toBe('correct');
    expect(competingCommits).toBe(0);
  });

  it('a different person claiming the visitor after its read is preserved and receives no borrowed consent', async () => {
    race = true;
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: 'reader@example.com', userId: 'actor' });
    const state = { result, contacts: await rows('crm_contacts'), visitors: await rows('mkt_visitors'), consent: await rows('mkt_consent_events') };
    observe('raced-final', state);
    expect(competingCommits).toBe(1);
    expect(state.contacts.find(row => row.id === 'correct')?.owner_id).toBe('actor');
    expect(state.visitors[0]?.contact_id).toBe('foreign');
    expect(state.consent[0]?.contact_id).toBeNull();
    expect(result.decision).not.toBe('link');
  });

  it('an actual refused visitor PATCH leaves consent unattributed and reports unknown', async () => {
    refuseVisitorPatch = true;
    const result = await stitchVisitorIdentity(db as never, { anonymousId: 'synthetic-visitor', email: 'reader@example.com', userId: 'actor' });
    const state = { result, contacts: await rows('crm_contacts'), visitors: await rows('mkt_visitors'), consent: await rows('mkt_consent_events') };
    observe('refused-patch-final', state);
    expect(refusedPatches).toBe(1);
    expect(state.contacts.find(row => row.id === 'correct')?.owner_id).toBe('actor');
    expect(state.visitors[0]?.contact_id).toBeNull();
    expect(state.consent[0]?.contact_id).toBeNull();
    expect(result).toEqual({ decision: 'unknown', contactId: 'correct' });
  });
});
