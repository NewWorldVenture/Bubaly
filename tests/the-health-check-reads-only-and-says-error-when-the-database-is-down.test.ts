// GET /api/health, driven end to end (Register B API-2F38298B7BB9).
//
// The route is public by design: uptime monitors and load balancers call it
// with no session. tests/the-health-body-names-no-configuration.test.ts already
// proves the public body (status, time, one boolean per check), the 503 on a
// missing required variable, the detail going only to the log and to a monitor
// presenting HEALTH_MONITOR_SECRET, and refusal of a wrong bearer, an unset
// secret and a bare secret header. tests/shared-secrets-compare-in-constant-time.test.ts
// proves the bearer is compared in constant time.
//
// What is added here: a signed-in caller's session (a parent's, or a site
// super admin's) is not the monitor credential and unlocks no detail; the check
// only READS — every outbound request is a GET to the configured Supabase
// project and nothing else; a database probe that fails outright (the fetch
// rejects, with internal text in the error) is answered 503 "error", and an
// auth-service outage 200 "degraded", each without the failure's text in the
// public body.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_ENV } from '@/lib/health/status';

const SUPABASE = 'https://health-audit-fixture.supabase.co';
const SERVICE_KEY = 'fake-audit-service-role-key';
const INTERNAL = 'connect ECONNREFUSED 10.0.0.12:5432 internal-db-host';

type Call = { url: string; method: string };
let calls: Call[] = [];
let failing: { database?: boolean; auth?: boolean } = {};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const key = new Headers(init?.headers).get('apikey');
    if (url.endsWith('/rest/v1/') && key !== SERVICE_KEY && failing.database) throw new Error(INTERNAL);
    if (url.endsWith('/auth/v1/health') && failing.auth) throw new Error(INTERNAL);
    return new Response('{}', { status: 200 });
  }));
}

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/health/route');
  const response = await GET(new NextRequest('https://app.example.com/api/health', { headers }));
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as { status: string; checks: Record<string, Record<string, unknown>> } };
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  failing = {};
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-audit-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  for (const name of FEATURE_ENV) vi.stubEnv(name, 'fake-audit-configured');
  vi.stubEnv('HEALTH_MONITOR_SECRET', 'fake-audit-monitor-secret');
  stubFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('API-2F38298B7BB9 who may read the detail', () => {
  it.each([
    ['a parent\'s session cookie', { cookie: 'sb-access-token=fake-parent-session' }],
    ['a super admin\'s session cookie', { cookie: 'sb-access-token=fake-super-admin-session' }],
    ['a user access token as a bearer', { authorization: 'Bearer fake-user-access-token' }],
  ])('API-2F38298B7BB9 %s gets the public body only', async (_label, headers) => {
    failing.auth = true;
    const { response, text, body } = await get(headers);
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(['status', 'timestamp', 'checks']);
    expect(body.checks.auth).toEqual({ ok: false });
    expect(text).not.toContain('latencyMs');
    expect(text).not.toContain('ECONNREFUSED');
  });
});

describe('API-2F38298B7BB9 a check that only reads', () => {
  it('API-2F38298B7BB9 every outbound request is a GET to the configured project, and the healthy answer is 200 ok, uncached', async () => {
    const { response, body } = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(body.status).toBe('ok');
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url.startsWith(`${SUPABASE}/`)).toBe(true);
    }
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual(['/auth/v1/health', '/rest/v1/', '/rest/v1/']);
  });
});

describe('API-2F38298B7BB9 a failed dependency', () => {
  it('API-2F38298B7BB9 a database probe that fails outright is 503 "error", with no failure text in the public body', async () => {
    failing.database = true;
    const { response, text, body } = await get();
    expect(response.status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.checks.database).toEqual({ ok: false });
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('internal-db-host');
  });

  it('API-2F38298B7BB9 an auth-service outage is 200 "degraded", not ok and not a fleet-wide 503', async () => {
    failing.auth = true;
    const { response, body } = await get();
    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.auth).toEqual({ ok: false });
    expect(body.checks.database).toEqual({ ok: true });
  });

  it('API-2F38298B7BB9 the monitor bearer sees the failing probe as failed, with its detail (control for the gate above)', async () => {
    failing.database = true;
    const { response, body } = await get({ authorization: 'Bearer fake-audit-monitor-secret' });
    expect(response.status).toBe(503);
    expect(body.checks.database).toMatchObject({ ok: false });
    expect(Object.keys(body.checks.database).length).toBeGreaterThan(1);
  });
});
