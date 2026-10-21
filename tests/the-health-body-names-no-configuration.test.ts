// GET /api/health tells an anonymous caller what is up, not how the deployment
// is configured (audit N5).
//
// The public body used to be the whole report: the NAMES of every unset feature
// secret (which fail-closed subsystems are dead), whether the service-role
// credential is accepted, and the upstream probes' error text. No secret value,
// ever — but a configuration description anyone could read and a scanner could
// keep. Driven through the real route with the probes' fetch stubbed: the public
// body carries status, time and one boolean per check; the detail goes to the
// log and to a monitor presenting the HEALTH_MONITOR_SECRET bearer; the status
// codes monitors key on are unchanged.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_ENV } from '@/lib/health/status';

const SERVICE_KEY = 'synthetic-bad-service-key';

function stubFetch(serviceRoleStatus: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const key = new Headers(init?.headers).get('apikey');
    if (String(url).endsWith('/rest/v1/') && key === SERVICE_KEY) return new Response('{}', { status: serviceRoleStatus });
    return new Response('{}', { status: 200 });
  }));
}

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/health/route');
  const response = await GET(new NextRequest('https://bubaly.example/api/health', { headers }));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> & { checks: Record<string, Record<string, unknown>> } };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://health-fixture.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  for (const name of FEATURE_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HEALTH_MONITOR_SECRET', '');
  stubFetch(401);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the public body', () => {
  it('carries the status, the time and one boolean per check — no names, no error text, no latency', async () => {
    const { status, text, body } = await get();
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.features).toEqual({ ok: false });
    expect(body.checks.serviceRole).toEqual({ ok: false });
    expect(body.checks.database).toEqual({ ok: true });
    expect(Object.keys(body)).toEqual(['status', 'timestamp', 'checks']);
    for (const name of FEATURE_ENV) expect(text).not.toContain(name);
    expect(text).not.toContain('rejected the key');
    expect(text).not.toContain('missing');
    expect(text).not.toContain('latencyMs');
    expect(text).not.toContain('error');
  });

  it('keeps the status code monitors key on: 503 when a required variable is missing', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const { status, text, body } = await get();
    expect(status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.checks.env).toEqual({ ok: false });
    expect(text).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('is the whole story when everything is up (control)', async () => {
    for (const name of FEATURE_ENV) vi.stubEnv(name, 'set');
    stubFetch(200);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.values(body.checks).every((check) => check.ok === true)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('where the detail goes', () => {
  it('to the server log, failing checks only', async () => {
    await get();
    expect(console.warn).toHaveBeenCalledWith('[health] failing checks', expect.objectContaining({
      features: expect.objectContaining({ missing: expect.arrayContaining(['CRON_SECRET']) }),
      serviceRole: expect.objectContaining({ error: expect.stringContaining('401') }),
    }));
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>;
    expect(logged).not.toHaveProperty('database');
  });

  it('to a monitor that presents the configured bearer', async () => {
    vi.stubEnv('HEALTH_MONITOR_SECRET', 'synthetic-monitor-secret');
    const { status, body } = await get({ authorization: 'Bearer synthetic-monitor-secret' });
    expect(status).toBe(200);
    expect(body.checks.features).toMatchObject({ ok: false, missing: expect.arrayContaining(['CRON_SECRET', 'CHILD_LOGIN_SECRET']) });
    expect(body.checks.serviceRole).toMatchObject({ ok: false, error: 'service-role rejected the key (401)' });
    expect(typeof body.checks.database.latencyMs).toBe('number');
  });

  it.each([
    ['a wrong bearer', 'synthetic-monitor-secret', 'Bearer wrong'],
    ['a bearer with no secret configured', '', 'Bearer anything'],
    ['the secret as a plain header value', 'synthetic-monitor-secret', 'synthetic-monitor-secret'],
  ])('not to %s', async (_label, secret, header) => {
    vi.stubEnv('HEALTH_MONITOR_SECRET', secret);
    const { text, body } = await get({ authorization: header });
    expect(body.checks.features).toEqual({ ok: false });
    expect(text).not.toContain('CRON_SECRET');
  });
});
