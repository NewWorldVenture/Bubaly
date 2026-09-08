import { describe, expect, it, vi, afterEach } from 'vitest';
import { summarizeHealth, buildHealthReport, checkRequiredEnv } from '../lib/health/status';
import { probeServiceRole, probeDatabase } from '../lib/health/probe';

const OK = { ok: true, latencyMs: 5 };
const ENV_OK = { ok: true, missing: [] };

afterEach(() => vi.unstubAllGlobals());

const respondWith = (status: number) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));

describe('probeServiceRole', () => {
  it('fails when Supabase REJECTS the key, which is the whole point of the probe', async () => {
    respondWith(401);
    const result = await probeServiceRole('https://x.supabase.co', 'a-key-this-project-does-not-accept');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('also fails on 403', async () => {
    respondWith(403);
    expect((await probeServiceRole('https://x.supabase.co', 'k')).ok).toBe(false);
  });

  it('passes when the key is accepted', async () => {
    respondWith(200);
    expect((await probeServiceRole('https://x.supabase.co', 'k')).ok).toBe(true);
  });

  it('fails when the key is absent entirely', async () => {
    respondWith(200);
    const result = await probeServiceRole('https://x.supabase.co', undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('supabase env not configured');
  });

  // The connectivity probes must NOT gain this behaviour: a 401 from the
  // OpenAPI root still proves the gateway answered, and treating that as down
  // would fail the whole deployment over a permissions detail.
  it('leaves probeDatabase treating 401 as reachable', async () => {
    respondWith(401);
    expect((await probeDatabase('https://x.supabase.co', 'anon')).ok).toBe(true);
  });
});

describe('summarizeHealth with a service-role probe', () => {
  // The exact production state on 2026-09-07: env present, anon key working,
  // PostgREST and GoTrue both fine — and every admin read returning
  // "Unregistered API key". The endpoint reported `ok` throughout.
  it('degrades when the key is present but rejected', () => {
    expect(summarizeHealth(ENV_OK, OK, OK, { ok: false, latencyMs: 8 })).toBe('degraded');
  });

  it('is a 200, never a 503 — admin is broken but public traffic is not', () => {
    const report = buildHealthReport(ENV_OK, OK, OK, new Date(), { ok: false, latencyMs: 8 });
    expect(report.httpStatus).toBe(200);
    expect(report.status).toBe('degraded');
  });

  it('still reports ok when the key is accepted', () => {
    expect(summarizeHealth(ENV_OK, OK, OK, OK)).toBe('ok');
  });

  it('a missing env var still outranks it as a hard 503', () => {
    const env = { ok: false, missing: ['SUPABASE_SERVICE_ROLE_KEY'] };
    expect(buildHealthReport(env, OK, OK, new Date(), { ok: false, latencyMs: null }).httpStatus).toBe(503);
  });

  it('omitting the probe preserves the previous behaviour exactly', () => {
    expect(summarizeHealth(ENV_OK, OK, OK)).toBe('ok');
    expect(buildHealthReport(ENV_OK, OK, OK).checks).not.toHaveProperty('serviceRole');
  });

  it('reports only a boolean and latency — never the key itself', () => {
    const report = buildHealthReport(ENV_OK, OK, OK, new Date(), { ok: false, latencyMs: 8, error: 'service-role rejected the key (401)' });
    expect(JSON.stringify(report)).not.toContain('eyJ');
    expect(report.checks.serviceRole).toEqual({ ok: false, latencyMs: 8, error: 'service-role rejected the key (401)' });
  });
});

describe('the gap this closes', () => {
  it('presence alone cannot distinguish a valid key from a wrong one', () => {
    const wrong = { NEXT_PUBLIC_SUPABASE_URL: 'u', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'wrong-project-key' };
    // checkRequiredEnv is satisfied — which is why production reported healthy.
    expect(checkRequiredEnv(wrong)).toEqual({ ok: true, missing: [] });
    // Only the probe can tell the difference.
    expect(summarizeHealth(ENV_OK, OK, OK, { ok: false, latencyMs: 8 })).toBe('degraded');
  });
});
