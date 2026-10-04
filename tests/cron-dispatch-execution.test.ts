import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULES, isSubDaily } from '../scripts/cron-dispatch.mjs';

const SCRIPT = resolve('scripts/cron-dispatch.mjs');
const SECRET = 'unit-test-cron-secret-do-not-log';
const AT = ['--at', '2026-09-12T12:05:00Z'];
const FIXED_TICK_ROUTES = [
  '/api/cron/ai-runs', '/api/cron/close-auctions', '/api/cron/contact-center-urgent',
  '/api/cron/guardian-sms-recovery',
  '/api/cron/marketing', '/api/cron/social-publish',
];
const SINGLE = [...AT, '--route', '/api/cron/notifications'];
/** The previous successful tick: about three hours before AT, the median gap GitHub actually delivers. */
const SINCE = '2026-09-12T08:58:00Z';
/** Sub-daily and due in (08:58, 12:05]: the fixed six plus the seven a five-minute window would have lost. */
const CATCH_UP_ROUTES = [
  ...FIXED_TICK_ROUTES,
  '/api/cron/checkout-abandoned', '/api/cron/family-routines', '/api/cron/feedback-github-sync',
  '/api/cron/journey-recovery', '/api/cron/library-feeds', '/api/cron/marketing-social', '/api/cron/push-scan',
].sort();
const SUB_DAILY_ROUTES = Object.entries(SCHEDULES).filter(([, expr]) => isSubDaily(expr)).map(([route]) => route).sort();
const observedFetch = `
globalThis.fetch = async (url, init) => {
  console.log('TEST_DISPATCH ' + JSON.stringify({ url: String(url), authorized: init.headers.Authorization === 'Bearer ' + process.env.CRON_SECRET, redirect: init.redirect, signal: init.signal instanceof AbortSignal }));
  return new Response('done', { status: 200 });
};`;

/** Real CLI process; every test replaces fetch before entrypoint evaluation. */
function cli(args = SINGLE, overrides: Record<string, string | undefined> = {}, preload = observedFetch) {
  // CRON_SINCE is cleared so a boundary in the host environment cannot widen the fixed-tick cases.
  const env: NodeJS.ProcessEnv = { ...process.env, CRON_SECRET: SECRET, CRON_BASE_URL: 'https://cron.invalid', CRON_SINCE: undefined, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, SCRIPT, ...args], { env, encoding: 'utf8', timeout: 5_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('cron dispatcher CLI configuration and dispatch', () => {
  it.each([undefined, '', '   ', '\n'])('fails without a configured secret (%j) and never dispatches', secret => {
    const result = cli(AT, { CRON_SECRET: secret });
    expect(result.status).toBe(1);
    expect(result.output).toContain('CRON_SECRET is required');
    expect(result.output).not.toContain('TEST_DISPATCH');
    expect(result.output).not.toContain(SECRET);
  });

  it('keeps an explicit dry run usable without credentials or requests', () => {
    const result = cli([...AT, '--dry-run'], { CRON_SECRET: undefined });
    expect(result.status).toBe(0);
    expect(result.output).toContain('/api/cron/ai-runs');
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it('dispatches a registered manual route with auth, cancellation and redirect refusal', () => {
    const result = cli();
    expect(result.status).toBe(0);
    expect(result.output).toContain('"url":"https://cron.invalid/api/cron/notifications"');
    expect(result.output).toContain('"authorized":true');
    expect(result.output).toContain('"signal":true');
    expect(result.output).toContain('"redirect":"manual"');
    expect(result.output).toContain('OK   200 /api/cron/notifications');
    expect(result.output).not.toContain(SECRET);
  });

  it('dispatches all routes due at the fixed five-minute tick, once each', () => {
    const result = cli(AT);
    expect(result.status).toBe(0);
    const calls = result.output.split('\n').filter(line => line.startsWith('TEST_DISPATCH ')).map(line => JSON.parse(line.slice('TEST_DISPATCH '.length)).url);
    expect(calls.sort()).toEqual(FIXED_TICK_ROUTES.map(route => `https://cron.invalid${route}`));
  });

  it.each(['@unexpected.invalid', '/api/cron/not-registered', '/api/health', 'https://unexpected.invalid'])('rejects an unregistered manual route %s before dispatch', route => {
    const result = cli([...AT, '--route', route]);
    expect(result.status).toBe(2);
    expect(result.output).toContain('Invalid --route');
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it('rejects a missing manual route argument instead of silently running the schedule', () => {
    const result = cli([...AT, '--route']);
    expect(result.status).toBe(2);
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it.each(['not-a-url', 'ftp://cron.invalid', 'http://cron.invalid', 'https://user:password@cron.invalid', 'https://cron.invalid?token=private'])('rejects insecure, malformed or credential-bearing base config without echoing it', base => {
    const result = cli(SINGLE, { CRON_BASE_URL: base });
    expect(result.status).toBe(2);
    expect(result.output).toContain('Invalid CRON_BASE_URL');
    expect(result.output).not.toContain(base);
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('allows HTTP loopback for local dispatch at %s', base => {
    const result = cli(SINGLE, { CRON_BASE_URL: base });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`"url":"${base}/api/cron/notifications"`);
    expect(result.output).toContain('"authorized":true');
  });

  it.each([401, 403, 307, 500])('fails when a configured route returns HTTP %i', status => {
    const result = cli(SINGLE, {}, `globalThis.fetch = async () => new Response('rejected', { status: ${status} });`);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`FAIL ${status} /api/cron/notifications`);
    expect(result.output).toContain('1 of 1 cron route(s) failed');
  });

  it('redacts the configured secret from an upstream error before logging', () => {
    const result = cli(SINGLE, {}, `globalThis.fetch = async () => { throw new Error('provider rejected ' + process.env.CRON_SECRET); };`);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain('[redacted]');
  });

  it('redacts reflected credentials from a response preview', () => {
    const result = cli(SINGLE, {}, `globalThis.fetch = async () => new Response('upstream body: ' + process.env.CRON_SECRET, { status: 500 });`);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain('[redacted]');
  });

  it('rejects a multiline secret before constructing an authorization header', () => {
    const result = cli(SINGLE, { CRON_SECRET: `${SECRET}\nextra` });
    expect(result.status).toBe(2);
    expect(result.output).toContain('Invalid CRON_SECRET');
    expect(result.output).not.toContain(SECRET);
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it('reports a failed tick while still attempting every due route', () => {
    const result = cli(AT, {}, `globalThis.fetch = async url => { console.log('TEST_ATTEMPT ' + String(url)); return new Response('result', { status: String(url).endsWith('/marketing') ? 503 : 200 }); };`);
    expect(result.status).toBe(1);
    const calls = result.output.split('\n').filter(line => line.startsWith('TEST_ATTEMPT ')).map(line => line.slice('TEST_ATTEMPT '.length).trim());
    expect(calls.sort()).toEqual(FIXED_TICK_ROUTES.map(route => `https://cron.invalid${route}`));
    expect(result.output).toContain(`1 of ${FIXED_TICK_ROUTES.length} cron route(s) failed`);
  });

  it('cancels an oversized response after reading a bounded preview', () => {
    const result = cli(SINGLE, {}, `
globalThis.fetch = async () => {
  let chunks = 0;
  return new Response(new ReadableStream({
    pull(controller) { if (++chunks > 20) controller.close(); else controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); },
    cancel() { console.log('TEST_RESPONSE_CANCELLED ' + chunks); }
  }), { status: 200 });
};`);
    expect(result.status).toBe(0);
    const chunks = /TEST_RESPONSE_CANCELLED (\d+)/.exec(result.output)?.[1];
    expect(chunks).toBeDefined();
    expect(Number(chunks)).toBeLessThanOrEqual(6);
  });

  it('aborts a stalled request at the configured deadline and exits failed', () => {
    const result = cli(SINGLE, {}, `
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 120000 ? 10 : ms, ...args);
globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Dispatch deadline exceeded')), { once: true }));`);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Dispatch deadline exceeded');
  });
});

describe('cron dispatcher CLI catch-up from the previous tick', () => {
  const calls = (output: string) => output.split('\n').filter(line => line.startsWith('TEST_DISPATCH ')).map(line => JSON.parse(line.slice('TEST_DISPATCH '.length)).url as string).sort();

  it('catches up every sub-daily route due since the previous tick, once each, and leaves daily routes to Vercel', () => {
    const result = cli(AT, { CRON_SINCE: SINCE });
    expect(result.status).toBe(0);
    expect(result.output).toContain('(window 187 min from 2026-09-12T08:58:00.000Z)');
    expect(calls(result.output)).toEqual(CATCH_UP_ROUTES.map(route => `https://cron.invalid${route}`));
    expect(result.output).toContain('OK   200 /api/cron/journey-recovery');
    // 11:00 fell in the gap, but notifications is daily and vercel.json fired it.
    expect(result.output).not.toContain('/api/cron/notifications');
    // 10:00 and 12:00 both fell in the gap; push-scan was called once.
    expect(calls(result.output).filter(url => url.endsWith('/api/cron/push-scan'))).toHaveLength(1);
    expect(result.output).not.toContain(SECRET);
  });

  it.each(['not-a-timestamp', '2026-09-12T12:06:00Z'])('falls back to the fixed window for an unusable boundary %s and says so', since => {
    const result = cli(AT, { CRON_SINCE: since });
    expect(result.status).toBe(0);
    expect(result.output).toContain('(window 5 min; CRON_SINCE ignored:');
    expect(calls(result.output)).toEqual(FIXED_TICK_ROUTES.map(route => `https://cron.invalid${route}`));
  });

  it('clamps a boundary older than the cap: every sub-daily route is called exactly once and no daily one at all', () => {
    const result = cli(AT, { CRON_SINCE: '2026-09-01T00:00:00Z' });
    expect(result.status).toBe(0);
    expect(result.output).toContain('(window 1440 min from 2026-09-11T12:05:00.000Z; catch-up capped at 1440 min (CRON_SINCE 2026-09-01T00:00:00.000Z))');
    expect(SUB_DAILY_ROUTES).toHaveLength(17);
    expect(calls(result.output)).toEqual(SUB_DAILY_ROUTES.map(route => `https://cron.invalid${route}`));
    expect(result.output).not.toContain('/api/cron/admin-digest');
  });

  it('keeps a dry run with a boundary credential-free and lists the catch-up routes', () => {
    const result = cli([...AT, '--dry-run'], { CRON_SECRET: undefined, CRON_SINCE: SINCE });
    expect(result.status).toBe(0);
    expect(result.output).toContain('(window 187 min from 2026-09-12T08:58:00.000Z)');
    expect(result.output).toContain('/api/cron/journey-recovery');
    expect(result.output).not.toContain('/api/cron/notifications');
    expect(result.output).not.toContain('TEST_DISPATCH');
  });

  it('a manual route ignores the boundary', () => {
    const result = cli(SINGLE, { CRON_SINCE: SINCE });
    expect(result.status).toBe(0);
    expect(result.output).toContain('(window 5 min): /api/cron/notifications');
    expect(calls(result.output)).toEqual(['https://cron.invalid/api/cron/notifications']);
  });
});
