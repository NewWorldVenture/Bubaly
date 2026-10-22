// Three public ingestion routes answer a caller's malformed field as a
// refusal, not as a server failure (audit N9, N10, N11).
//
//   /api/exit-intent/track  `{ id: 1 }` threw in `.trim()` (an unhandled 500);
//                           `{ id: 'abc' }` reached the uuid-typed RPC, which
//                           refused it (22P02) — logged as an error, answered 500.
//   /api/lp/track           `{ slug: 123 }` threw in `.trim()` (an unhandled 500).
//   /api/forms/submit       a non-uuid formId reached the uuid column, which
//                           refused it (22P02) — logged as an error, answered a
//                           503 "temporarily unavailable" for a bad request.
//
// Driven through the real routes against the in-memory database (which, unlike
// Postgres, accepts any string where a uuid belongs — so what these pin is that
// the read or RPC is never REACHED with the bad value). The controls prove a
// well-formed body still records its metric or reaches its read.
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, rpc: [] as Array<{ name: string; args: Record<string, unknown> }> }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/public-form-automation', () => ({ firePublicFormSubmitted: vi.fn() }));

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function json(path: string, body: unknown) {
  return new NextRequest(`https://bubaly.example/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body),
  });
}
const exitIntent = async (body: unknown) => (await import('@/app/api/exit-intent/track/route')).POST(json('exit-intent/track', body));
const landing = async (body: unknown) => (await import('@/app/api/lp/track/route')).POST(json('lp/track', body));
const forms = async (body: unknown) => (await import('@/app/api/forms/submit/route')).POST(json('forms/submit', body));
const reads = (table: string) => db.log.filter((entry) => entry.table === table).length;

beforeEach(() => {
  vi.resetModules();
  h.rpc = [];
  const record = (name: string) => (args: Record<string, unknown>) => { h.rpc.push({ name, args }); return null; };
  db = createInMemorySupabase({ rpc: {
    rate_limit_hit: rateLimitHit, bump_exit_intent: record('bump_exit_intent'), bump_landing_metric: record('bump_landing_metric'),
  } });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/api/exit-intent/track (N9)', () => {
  it.each([
    ['a number', { id: 1 }],
    ['an object', { id: {} }],
    ['an array', { id: ['x'] }],
    ['a string that is not a uuid', { id: 'abc' }],
    ['a uuid with a suffix', { id: `${UUID}x` }],
  ])('%s as id is 422, reaches no RPC and logs no error', async (_label, body) => {
    const response = await exitIntent(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'track.idIsRequired' });
    expect(h.rpc.filter((call) => call.name === 'bump_exit_intent')).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a uuid id records the metric (control)', async () => {
    const response = await exitIntent({ id: UUID, kind: 'conversion' });
    expect(response.status).toBe(200);
    expect(h.rpc).toContainEqual({ name: 'bump_exit_intent', args: { p_id: UUID, p_metric: 'conversion' } });
  });
});

describe('/api/lp/track (N10)', () => {
  it.each([
    ['a number', { slug: 123 }],
    ['an object', { slug: {} }],
    ['an array', { slug: ['spring'] }],
    ['a boolean', { slug: true }],
  ])('%s as slug is 422 and reaches no RPC', async (_label, body) => {
    const response = await landing(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'track.slugIsRequired' });
    expect(h.rpc.filter((call) => call.name === 'bump_landing_metric')).toEqual([]);
  });

  it('a slug past the identifier bound is 422', async () => {
    const response = await landing({ slug: 'x'.repeat(201) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'track.identifierIsTooLong' });
    expect(h.rpc.filter((call) => call.name === 'bump_landing_metric')).toEqual([]);
  });

  it('a string slug records the metric, lower-cased (control)', async () => {
    const response = await landing({ slug: ' Spring-Sale ', kind: 'view' });
    expect(response.status).toBe(200);
    expect(h.rpc).toContainEqual({ name: 'bump_landing_metric', args: { p_slug: 'spring-sale', p_metric: 'view' } });
  });
});

describe('/api/forms/submit (N11)', () => {
  it.each(['abc', '123', `${UUID}x`, 'not-a-form'])('formId %s is a 422 refusal that reaches no read and logs no error', async (formId) => {
    const response = await forms({ formId, values: { email: 'a@example.com' } });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'submit.thatFormIdIsNotValid' });
    expect(reads('marketing_forms')).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('the refusal has copy in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['submit.thatFormIdIsNotValid'], `${locale} is missing it`).toBeTruthy();
    }
  });

  it('a uuid that names no form is read, then 404 (control: the read is reached)', async () => {
    const response = await forms({ formId: UUID, values: {} });
    expect(response.status).toBe(404);
    expect(reads('marketing_forms')).toBe(1);
  });

  it('an empty formId is still the 422 it was', async () => {
    const response = await forms({ formId: '', values: {} });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'submit.formidIsRequired' });
  });
});
