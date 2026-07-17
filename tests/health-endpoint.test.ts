import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  REQUIRED_ENV,
  checkRequiredEnv,
  summarizeHealth,
  buildHealthReport,
} from '../lib/health/status';
import { probeDatabase } from '../lib/health/probe';

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
    expect(summarizeHealth({ ok: false, missing: ['X'] }, { ok: true, latencyMs: 5 })).toBe('error');
  });

  it('is error when env ok but the database is unreachable', () => {
    expect(summarizeHealth({ ok: true, missing: [] }, { ok: false, latencyMs: null })).toBe('error');
  });

  it('is ok only when both probes pass', () => {
    expect(summarizeHealth({ ok: true, missing: [] }, { ok: true, latencyMs: 12 })).toBe('ok');
  });
});

describe('buildHealthReport', () => {
  it('maps ok -> 200 and carries the checks + iso timestamp', () => {
    const now = new Date('2026-07-17T13:00:00.000Z');
    const report = buildHealthReport({ ok: true, missing: [] }, { ok: true, latencyMs: 8 }, now);
    expect(report.status).toBe('ok');
    expect(report.httpStatus).toBe(200);
    expect(report.timestamp).toBe('2026-07-17T13:00:00.000Z');
    expect(report.checks.database.latencyMs).toBe(8);
  });

  it('maps error -> 503', () => {
    const report = buildHealthReport({ ok: false, missing: ['X'] }, { ok: false, latencyMs: null });
    expect(report.httpStatus).toBe(503);
    expect(report.status).toBe('error');
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
