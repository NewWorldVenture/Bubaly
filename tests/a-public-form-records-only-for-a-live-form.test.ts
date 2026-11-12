// POST /api/forms/submit, driven end to end (Register B API-5D86C14BDD41).
//
// A public endpoint: an anonymous visitor submits a published marketing form,
// so member roles and super admins are n/a. The real route and the real per-IP
// limiter (local and durable, over rate_limit_hit) run over an in-memory
// database holding a live form, a draft, a deleted one, and two households.
// The form_submitted automation is stubbed at its module seam — its mail bound
// is driven for real in tests/a-public-form-cannot-aim-automation-mail.test.ts
// and a-public-form-inbox-allowance-holds-at-every-send.test.ts.
//
// Already proven elsewhere and not repeated: the per-inbox automation bound
// and suppressions (the two files above); the limiter being the shared durable
// one (public-side-effect-rate-limit, a source scan); a malformed body
// (a-malformed-public-track-body-is-refused-not-a-500, request-body-boundaries).
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, automation: vi.fn() }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/marketing/public-form-automation', () => ({ firePublicFormSubmitted: h.automation }));

const FORM_LIVE = '7e3c2d1a-5b4f-4c8e-9a1d-2f3e4b5c6d7e';
const FORM_DRAFT = '7e3c2d1a-5b4f-4c8e-9a1d-2f3e4b5c6d7f';
const FORM_DELETED = '7e3c2d1a-5b4f-4c8e-9a1d-2f3e4b5c6d80';
const FORM_UNKNOWN = '7e3c2d1a-5b4f-4c8e-9a1d-2f3e4b5c6d81';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const IP = '192.0.2.44';
const FIELDS = [
  { label: 'Full name', key: 'full_name', type: 'text', required: true },
  { label: 'Email', key: 'email', type: 'email', required: true },
  { label: 'Company', key: 'company', type: 'text', required: false },
];
const VALUES = { full_name: '  Jordan Lee ', email: 'Jordan@Example.com', company: '', stray: 'not a field' };

let db: InMemorySupabase;

function boot() {
  db = createInMemorySupabase({
    rpc: { rate_limit_hit: rateLimitHit },
    uuidColumns: { marketing_forms: ['id'], marketing_form_submissions: ['form_id'] },
  });
  db.seed('families', [{ id: FAMILY_A, name: 'Rivera family' }, { id: FAMILY_B, name: 'Okafor family' }]);
  db.seed('marketing_forms', [
    { id: FORM_LIVE, name: 'Newsletter', status: 'active', deleted_at: null, fields: FIELDS },
    { id: FORM_DRAFT, name: 'Draft survey', status: 'draft', deleted_at: null, fields: FIELDS },
    { id: FORM_DELETED, name: 'Old giveaway', status: 'active', deleted_at: '2026-09-01T00:00:00Z', fields: FIELDS },
  ]);
  h.db = db;
}

async function submit(formId: string, values: Record<string, unknown> = VALUES, ip = IP) {
  const { POST } = await import('@/app/api/forms/submit/route');
  return POST(new NextRequest('https://www.bubaly.com/api/forms/submit', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ formId, values }),
  }));
}

const submissions = () => db.table('marketing_form_submissions');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules(); // a fresh per-instance limiter for every case
  h.automation.mockReset().mockResolvedValue(undefined);
  boot();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('an anonymous submission (member roles and admin: n/a, public)', () => {
  it('API-5D86C14BDD41 a valid submission to a live form answers ok and records exactly the declared, trimmed fields', async () => {
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]).toMatchObject({
      form_id: FORM_LIVE,
      email: 'jordan@example.com',
      data: { full_name: 'Jordan Lee', email: 'Jordan@Example.com' },
      source: 'public-form',
    });
    expect(submissions()[0].family_id).toBeUndefined();
    expect(h.automation).toHaveBeenCalledTimes(1);
    expect(h.automation.mock.calls[0][0]).toMatchObject({
      email: 'jordan@example.com', name: 'Jordan Lee',
      context: { source: 'marketing-form', formId: FORM_LIVE, formName: 'Newsletter' },
    });
    expect(String(h.automation.mock.calls[0][0].subjectKey)).toContain(String(submissions()[0].id));
  });

  it('API-5D86C14BDD41 a missing required field is refused 422 with the field named, and nothing is recorded or fired', async () => {
    const res = await submit(FORM_LIVE, { email: 'jordan@example.com' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'submit.validationFailed', fields: { full_name: 'Full name is required' } });
    expect(submissions()).toHaveLength(0);
    expect(h.automation).not.toHaveBeenCalled();
  });

  it('API-5D86C14BDD41 the eleventh submission from one address in a minute is refused 429 with Retry-After and records nothing', async () => {
    for (let i = 0; i < 10; i++) expect((await submit(FORM_LIVE)).status).toBe(200);
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'submit.tooManySubmissionsPleaseTry' });
    expect(submissions()).toHaveLength(10);
    expect(h.automation).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(db.table('rate_limits'))).not.toContain(IP);
  });
});

describe('a form that is not live (the "another household" analogue: forms belong to the platform, not a family)', () => {
  it.each([
    ['a draft form', FORM_DRAFT],
    ['a deleted form', FORM_DELETED],
    ['a well-formed id that names no form', FORM_UNKNOWN],
  ])('API-5D86C14BDD41 %s answers 404 and records nothing', async (_label, id) => {
    const before = JSON.stringify(db.table('marketing_forms'));
    const res = await submit(id);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'submit.thisFormIsNoLonger' });
    expect(text).not.toContain('Draft survey');
    expect(text).not.toContain('Old giveaway');
    expect(submissions()).toHaveLength(0);
    expect(h.automation).not.toHaveBeenCalled();
    expect(JSON.stringify(db.table('marketing_forms'))).toBe(before);
  });

  it('API-5D86C14BDD41 a household id in place of a form id names no form: 404, nothing recorded', async () => {
    const res = await submit(FAMILY_B);
    expect(res.status).toBe(404);
    expect(submissions()).toHaveLength(0);
  });
});

describe('failure', () => {
  it('API-5D86C14BDD41 a failed form read answers 503 unavailable, not "no longer available", and leaks no database text', async () => {
    h.db = withFaults(db, (table) => (table === 'marketing_forms' ? { code: '57014', message: 'canceling statement due to statement timeout on marketing_forms' } : null));
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'submit.thisFormIsTemporarilyUnavailable' });
    expect(text).not.toContain('statement timeout');
    expect(submissions()).toHaveLength(0);
    expect(h.automation).not.toHaveBeenCalled();
  });

  it('API-5D86C14BDD41 a refused submission write answers 500 without database text, and fires no automation', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'marketing_form_submissions' && calls.some((c) => c.method === 'insert')
      ? { code: '23514', message: 'new row for relation "marketing_form_submissions" violates check constraint' } : null));
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'submit.weCouldnTRecordYour' });
    expect(text).not.toContain('check constraint');
    expect(submissions()).toHaveLength(0);
    expect(h.automation).not.toHaveBeenCalled();
  });

  it('API-5D86C14BDD41 a limiter that cannot be evaluated refuses 429 and records nothing (fails closed)', async () => {
    const seeded = db;
    db = createInMemorySupabase(); // no rate_limit_hit: the RPC answers an error
    db.seed('marketing_forms', seeded.table('marketing_forms'));
    h.db = db;
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(429);
    expect(submissions()).toHaveLength(0);
    expect(h.automation).not.toHaveBeenCalled();
  });

  it('API-5D86C14BDD41 an automation that throws does not undo or fail a recorded submission', async () => {
    h.automation.mockRejectedValue(new Error('automation down'));
    const res = await submit(FORM_LIVE);
    expect(res.status).toBe(200);
    expect(submissions()).toHaveLength(1);
  });
});
