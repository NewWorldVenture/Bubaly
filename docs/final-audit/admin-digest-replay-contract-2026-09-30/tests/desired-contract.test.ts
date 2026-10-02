// UNRESOLVED EVIDENCE — minimal reproductions of the admin-digest idempotency
// contract that current main does NOT meet (API-96040DFB5635, JOB-EF2453D9F633).
//
// Every case except the control is EXPECTED TO FAIL until the route is fixed.
// This file lives outside `tests/`, so `npm test` does not collect it; run it with
//   npx vitest run --dir docs/final-audit/admin-digest-replay-contract-2026-09-30
// The observed failure output is saved next to the README. When a fix lands, these
// assertions are the acceptance test: move them into tests/, adapting imports and
// fixtures to the fixed route as needed, but keep every behavioural requirement and
// do not weaken any assertion.
//
// Same boundaries as tests/admin-digest-replay-contract.test.ts: the real handler,
// cron auth, paging, recipient lookup and sendEmail; a fake database, a fake clock
// and a fake Resend at the `fetch` boundary. Nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from '../../../../tests/helpers/in-memory-supabase';

/** `body` is the exact request payload, so a retry can be compared with the original. */
type Attempt = { to: string; html: string; body: string; idempotencyKey: string | null; accepted: boolean };
const state = vi.hoisted(() => ({
  db: null as unknown,
  attempts: [] as Attempt[],
  mode: {} as Record<string, 'accept' | 'refuse' | 'accept-then-timeout'>,
  failSuperAdmins: false,
  barrier: null as null | { parties: number; arrived: number; release: () => void; gate: Promise<void> },
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const SECOND = 'second-admin@example.test';
const recipients = () => [...new Set([...superAdminEmails(), SECOND])];
const alias = (to: string) => (to === SECOND ? 'admin-2' : `admin-${recipients().indexOf(to) + 1}`);
const per = (pick: (a: Attempt) => boolean) => {
  const out: Record<string, number> = Object.fromEntries(recipients().map((r) => [alias(r), 0]));
  for (const a of state.attempts) if (pick(a)) out[alias(a.to)] += 1;
  return out;
};
const accepted = () => per((a) => a.accepted);
const attempted = () => per(() => true);
const once = () => Object.fromEntries(recipients().map((r) => [alias(r), 1]));

let db: InMemorySupabase;
function client() {
  return {
    from(table: string) {
      const qb = db.from(table) as unknown as { then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown> };
      const then = qb.then.bind(qb);
      qb.then = (f, r) => {
        if (table === 'super_admins' && state.failSuperAdmins) {
          return Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected', details: null, hint: null } }).then(f, r);
        }
        const b = state.barrier;
        return then(async (reply) => {
          if (b && table === 'super_admins') { b.arrived += 1; if (b.arrived >= b.parties) b.release(); await b.gate; }
          return reply;
        }).then(f, r);
      };
      return qb;
    },
  };
}
const happen = (at: string, title: string) =>
  db.seed('admin_notifications', [{ id: `n-${title}`, kind: 'family_signup', title, created_at: new Date(at).toISOString() }]);
const call = () => GET(new Request('https://bubaly.test/api/cron/admin-digest', { headers: { authorization: 'Bearer test-cron-secret-not-real' } }) as never);
async function runAt(at: string) {
  vi.setSystemTime(new Date(at));
  const res = await call();
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.CRON_SECRET = 'test-cron-secret-not-real';
  process.env.RESEND_API_KEY = 'test-resend-key-not-real';
  process.env.SUPER_ADMIN_EMAILS = '';
  db = createInMemorySupabase();
  db.seed('super_admins', [{ email: SECOND }]);
  state.db = client();
  state.attempts = []; state.mode = {}; state.failSuperAdmins = false; state.barrier = null;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== 'https://api.resend.com/emails') throw new Error('network is disabled in this hermetic test');
    const body = JSON.parse(String(init?.body)) as { to: string; html: string };
    const mode = state.mode[body.to] ?? 'accept';
    state.attempts.push({ to: body.to, html: body.html, body: String(init?.body), idempotencyKey: new Headers(init?.headers).get('idempotency-key'), accepted: mode !== 'refuse' });
    if (mode === 'refuse') return new Response('{}', { status: 422 });
    if (mode === 'accept-then-timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response('{"id":"msg"}', { status: 200 });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ['CRON_SECRET', 'RESEND_API_KEY', 'SUPER_ADMIN_EMAILS']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('admin-digest idempotency contract (UNRESOLVED — C1–C5 expected to fail)', () => {
  it('CONTROL (passes): one on-time run delivers exactly one digest to each admin', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    expect((await runAt('2026-09-30T12:30:00Z')).status).toBe(200);
    expect(accepted()).toEqual(once());
  });

  it('C1 one occurrence, two sequential calls: each admin receives exactly one digest', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    await runAt('2026-09-30T12:30:00Z');
    await runAt('2026-09-30T12:30:00Z');
    expect(accepted()).toEqual(once());
  });

  it('C2 one occurrence, two concurrent calls: each admin receives exactly one digest', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    vi.setSystemTime(new Date('2026-09-30T12:30:00Z'));
    // Bounded synchronisation. On current main both callers reach the recipient read and
    // are held there until both have read, which forces the race. A correct fix may refuse
    // the loser EARLIER (a claim before any read), so the gate also opens as soon as either
    // call settles, and after at most 1 s of real time: an early refusal can never strand
    // the winner, and the outcome below is the whole requirement.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    state.barrier = { parties: 2, arrived: 0, release: () => release(), gate };
    const bound = setTimeout(() => release(), 1_000);
    try {
      await Promise.all([call(), call()].map((p) => p.finally(() => release())));
    } finally { clearTimeout(bound); }
    expect(accepted()).toEqual(once());
  });

  it('C3 a retry after one recipient failed attempts ONLY that recipient', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    state.mode[SECOND] = 'refuse';
    await runAt('2026-09-30T12:30:00Z');
    state.mode = {};
    await runAt('2026-09-30T12:30:00Z');
    expect(attempted()).toEqual({ 'admin-1': 1, 'admin-2': 2 });
    expect(accepted()).toEqual(once());
  });

  it('C4 an ambiguous send (accepted, then timed out) is retried under the SAME idempotency key, and nobody else is re-sent', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    state.mode[SECOND] = 'accept-then-timeout';
    await runAt('2026-09-30T12:30:00Z');
    state.mode = {};
    await runAt('2026-09-30T12:30:00Z');
    // Exactly one retry of the ambiguous send: the original and the retry.
    const ambiguous = state.attempts.filter((a) => a.to === SECOND);
    expect(ambiguous).toHaveLength(2);
    const [first, retry] = ambiguous;
    // A real key, the same key, and the same payload, so the provider can fold the retry into the original.
    expect(typeof first.idempotencyKey).toBe('string');
    expect(first.idempotencyKey).not.toBe('');
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.body).toBe(first.body);
    // The admin whose send was accepted cleanly is not sent again.
    expect(attempted()['admin-1']).toBe(1);
  });

  it('C5 Vercel at 12:30 and GitHub at 12:33: no activity row is reported in two digests', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    await runAt('2026-09-30T12:30:00Z');
    happen('2026-09-30T12:31:00Z', 'Signup Charlie');
    await runAt('2026-09-30T12:33:00Z');
    const toSecond = state.attempts.filter((a) => a.to === SECOND && a.accepted);
    expect(toSecond.filter((a) => a.html.includes('Signup Alpha'))).toHaveLength(1);
  });

  // C6 (a run that could not read its recipient list does not report a clean success) failed on
  // main at 231e8140, passes with #685 (desired-contract-output-combined-with-685.txt), and was
  // promoted to tests/admin-digest-replay-contract.test.ts. C1–C5 remain unmet.
});
