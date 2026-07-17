import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  REQUIRED_ENV,
  checkRequiredEnv,
  summarizeHealth,
  buildHealthReport,
} from '../lib/health/status';
import { probeDatabase, probeAuth } from '../lib/health/probe';

const OK = { ok: true, latencyMs: 5 };
const DOWN = { ok: false, latencyMs: null };

describe('checkRequiredEnv', () => {
  it('passes when every required var is present and non-blank', () => {
    const env = Object.fromEntries(REQUIRED_ENV.map((k) => [k, 'x'])) as Record<string, string>;
    expect(checkRequiredEnv(env)).toEqual({ ok: true, missing: [] });
  });

  it('reports the NAMES of missing vars (never values)', () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      // SUPABASE_SERVICE_ROLE_KEY intentionally absent
    };
    expect(checkRequiredEnv(env)).toEqual({
      ok: false,
      missing: ['SUPABASE_SERVICE_ROLE_KEY'],
    });
  });

  it('treats blank/whitespace as missing', () => {
    const env = Object.fromEntries(REQUIRED_ENV.map((k) => [k, '   '])) as Record<string, string>;
    expect(checkRequiredEnv(env).missing).toEqual([...REQUIRED_ENV]);
  });
});

describe('summarizeHealth', () => {
  it('is error when a required env var is missing (even if DB somehow ok)', () => {
    expect(summarizeHealth({ ok: false, missing: ['X'] }, OK, OK)).toBe('error');
  });

  it('is error when env ok but the database is unreachable', () => {
    expect(summarizeHealth({ ok: true, missing: [] }, DOWN, OK)).toBe('error');
  });

  it('is DEGRADED (not error) when only the auth service is down — LB-001 shape', () => {
    // env + data healthy, GoTrue down: keep serving anonymous/cached traffic
    // rather than 503-ing the whole fleet on a shared-upstream auth outage.
    expect(summarizeHealth({ ok: true, missing: [] }, OK, DOWN)).toBe('degraded');
  });

  it('is ok only when every probe passes', () => {
    expect(summarizeHealth({ ok: true, missing: [] }, OK, OK)).toBe('ok');
  });
});

describe('buildHealthReport', () => {
  it('maps ok -> 200 and carries the checks + iso timestamp', () => {
    const now = new Date('2026-07-17T13:00:00.000Z');
    const report = buildHealthReport({ ok: true, missing: [] }, { ok: true, latencyMs: 8 }, OK, now);
    expect(report.status).toBe('ok');
    expect(report.httpStatus).toBe(200);
    expect(report.timestamp).toBe('2026-07-17T13:00:00.000Z');
    expect(report.checks.database.latencyMs).toBe(8);
    expect(report.checks.auth.ok).toBe(true);
  });

  it('maps error -> 503', () => {
    const report = buildHealthReport({ ok: false, missing: ['X'] }, DOWN, OK);
    expect(report.httpStatus).toBe(503);
    expect(report.status).toBe('error');
  });

  it('maps degraded (auth-only outage) -> 200, not 503', () => {
    const report = buildHealthReport({ ok: true, missing: [] }, OK, DOWN);
    expect(report.status).toBe('degraded');
    expect(report.httpStatus).toBe(200);
  });
});

describe('probeDatabase', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without hitting the network when env is unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await probeDatabase(undefined, undefined);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports ok for a reachable PostgREST (2xx) and measures latency', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const result = await probeDatabase('https://x.supabase.co', 'anon-key');
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('sends the anon key as apikey against the /rest/v1/ root (RLS-independent)', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await probeDatabase('https://x.supabase.co/', 'anon-key');
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://x.supabase.co/rest/v1/');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.apikey).toBe('anon-key');
  });

  it('treats a 5xx from PostgREST as unhealthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const result = await probeDatabase('https://x.supabase.co', 'anon-key');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });

  it('fails closed (not throws) when fetch rejects / aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));
    const result = await probeDatabase('https://x.supabase.co', 'anon-key', 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
  });
});

describe('probeAuth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without hitting the network when env is unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await probeAuth(undefined, undefined);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hits the GoTrue /auth/v1/health endpoint with the anon apikey', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{"name":"GoTrue"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await probeAuth('https://x.supabase.co/', 'anon-key');
    expect(result.ok).toBe(true);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://x.supabase.co/auth/v1/health');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.apikey).toBe('anon-key');
  });

  it('treats a 5xx from GoTrue as unhealthy (the exact LB-001 failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Database error finding users', { status: 500 })));
    const result = await probeAuth('https://x.supabase.co', 'anon-key');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('gotrue');
    expect(result.error).toContain('500');
  });

  it('fails closed (not throws) when the auth probe aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));
    const result = await probeAuth('https://x.supabase.co', 'anon-key', 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
