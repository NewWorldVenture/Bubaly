// What GET /api/cron/admin-digest ACTUALLY does when a scheduler replays it.
// Audit rows API-96040DFB5635 (the endpoint) and JOB-EF2453D9F633 (the job).
//
// Before this file the route had no executable coverage: tests/admin-digest.test.ts
// unit-tests the pure helpers and pins the handler's source text (paging,
// `{ status: 502 }`, `summary.ok ? 200 : 502`), and the two scheduler guards
// (a-mirrored-cron-must-be-idempotent, a-late-tick-catches-up) read vercel.json
// and the dispatcher. Nothing ran the handler. This file does.
//
// It is a CHARACTERIZATION: every assertion is today's behaviour, including the
// behaviour that is wrong. A test passing here is not a claim that the route is
// right. The desired contract, and minimal reproductions that FAIL against it, are
// in docs/final-audit/admin-digest-replay-contract-2026-09-30/ (not collected by
// `npm test`, run with the command in that folder's README).
//
// What is real: the route handler, lib/server/cron-auth.ts, lib/supabase/read-all.ts
// paging, lib/feedback/notify.ts's recipient lookup, lib/constants/super-admins.ts,
// lib/admin/digest.ts, and lib/server/email.ts down to its `fetch`. What is fake:
// the database (tests/helpers/in-memory-supabase.ts, with `maxRows` standing in for
// PostgREST's db-max-rows), the clock (Date only), translations (identity), and
// Resend, which is a stub for global `fetch` that COUNTS what it is asked to send
// and what it accepts. Any other outbound URL fails the test. Nothing is sent.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { SCHEDULES, dueRoutes } from '../scripts/cron-dispatch.mjs';

type ProviderMode = 'accept' | 'refuse' | 'network-error' | 'accept-then-timeout';
type Attempt = { to: string; subject: string; html: string; idempotencyKey: string | null; accepted: boolean; folded: boolean };

const state = vi.hoisted(() => ({
  db: null as unknown,
  /** Every POST the fake Resend received, accepted or not. */
  attempts: [] as Attempt[],
  /** How the fake Resend answers each recipient. Default: accept. */
  mode: {} as Record<string, ProviderMode>,
  /** Outbound calls to anything other than the Resend endpoint (must stay empty). */
  strayNetwork: [] as string[],
  /** Executed reads and writes, by table. */
  reads: {} as Record<string, number>,
  writes: [] as { table: string; op: string }[],
  /** Fault injection: the Nth read of a table answers an error, or throws. */
  failRead: null as null | { table: string; call: number; how: 'error' | 'throw' },
  /** A read barrier: every party must COMPLETE this table's first-page read before any continues. */
  barrier: null as null | { table: string; parties: number; arrived: number; attemptsAtRelease: number | null; release: () => void; gate: Promise<void> },
  /** Replaces the recipient lookup's result (the only way to reach the empty-recipient branch). */
  recipientsOverride: null as string[] | null,
  /** The fake provider's key store: what Resend keeps for 24 h per Idempotency-Key. */
  keys: new Map<string, { payload: string; id: string }>(),
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/feedback/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback/notify')>();
  return {
    ...actual,
    allSuperAdminEmails: (...args: Parameters<typeof actual.allSuperAdminEmails>) =>
      (state.recipientsOverride ? Promise.resolve(state.recipientsOverride) : actual.allSuperAdminEmails(...args)),
    // Since #685 the route reads recipients through the strict reader; the override
    // answers in its success shape so the empty-recipient branch is still the one exercised.
    readSuperAdminRecipients: (...args: Parameters<typeof actual.readSuperAdminRecipients>) =>
      (state.recipientsOverride ? Promise.resolve({ emails: state.recipientsOverride, failure: null }) : actual.readSuperAdminRecipients(...args)),
  };
});

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const ROUTE = '/api/cron/admin-digest';
const CRON = 'test-cron-secret-not-real';
const RESEND_KEY = 'test-resend-key-not-real';
const RESEND_URL = 'https://api.resend.com/emails';
const SECOND = 'second-admin@example.test';

// ── the fake Resend ───────────────────────────────────────────────────────────
async function fakeResend(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== RESEND_URL) {
    state.strayNetwork.push(url);
    throw new Error('network is disabled in this hermetic test');
  }
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${RESEND_KEY}`);
  expect(init?.signal, 'every provider call carries a deadline').toBeInstanceOf(AbortSignal);
  const body = JSON.parse(String(init?.body)) as { to: string; subject: string; html: string };
  const idempotencyKey = headers.get('idempotency-key');
  // Resend's idempotency, as documented: a key it has accepted answers a repeat of the
  // SAME payload with the original result and sends nothing; a DIFFERENT payload under
  // a used key is a 409. Keys are kept for 24 h; this fake keeps them for the test.
  const payload = String(init?.body);
  const prior = idempotencyKey ? state.keys.get(idempotencyKey) : undefined;
  if (prior) {
    if (prior.payload === payload) {
      state.attempts.push({ to: body.to, subject: body.subject, html: body.html, idempotencyKey, accepted: true, folded: true });
      return new Response(JSON.stringify({ id: prior.id }), { status: 200 });
    }
    state.attempts.push({ to: body.to, subject: body.subject, html: body.html, idempotencyKey, accepted: false, folded: false });
    return new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 });
  }
  const mode = state.mode[body.to] ?? 'accept';
  const accepted = mode === 'accept' || mode === 'accept-then-timeout';
  state.attempts.push({ to: body.to, subject: body.subject, html: body.html, idempotencyKey, accepted, folded: false });
  if (accepted && idempotencyKey) state.keys.set(idempotencyKey, { payload, id: `msg_${state.attempts.length}` });
  if (mode === 'refuse') return new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 });
  if (mode === 'network-error') throw new TypeError('fetch failed');
  // The fake provider accepted it (a real one would go on to deliver it), but the 15 s deadline fired before the answer arrived.
  if (mode === 'accept-then-timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  return new Response(JSON.stringify({ id: `msg_${state.attempts.length}` }), { status: 200 });
}

// ── the database client the handler receives ──────────────────────────────────
function clientOver(inner: InMemorySupabase) {
  return {
    from(table: string) {
      const qb = inner.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        const original = qb[op].bind(qb);
        qb[op] = (...args: unknown[]) => { state.writes.push({ table, op }); return original(...args); };
      }
      // Paged reads (readAll) ask for .range(from, to); remember `from` so the barrier can hold
      // only the FIRST page of each invocation, without pinning how many pages a read takes.
      let rangeFrom = 0;
      const originalRange = qb.range.bind(qb);
      qb.range = (...args: unknown[]) => { rangeFrom = Number(args[0]); return originalRange(...args); };
      const originalThen = qb.then.bind(qb) as (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown>;
      qb.then = ((onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
        state.reads[table] = (state.reads[table] ?? 0) + 1;
        const f = state.failRead;
        if (f && f.table === table && f.call === state.reads[table]) {
          if (f.how === 'throw') return Promise.reject(new Error(`injected: ${table} read threw`)).then(onFulfilled, onRejected);
          return Promise.resolve({ data: null, error: { code: 'XX000', message: `injected: ${table} read failed`, details: null, hint: null }, count: null, status: 500, statusText: 'Internal Server Error' })
            .then(onFulfilled, onRejected);
        }
        const b = state.barrier;
        return originalThen(async (reply) => {
          if (b && b.table === table && rangeFrom === 0) {
            b.arrived += 1;
            if (b.arrived >= b.parties) { b.attemptsAtRelease = state.attempts.length; b.release(); }
            await b.gate;
          }
          return reply;
        }).then(onFulfilled, onRejected);
      }) as never;
      return qb;
    },
  };
}

function barrierOn(table: string, parties: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.barrier = { table, parties, arrived: 0, attemptsAtRelease: null, release, gate };
}

// ── helpers ───────────────────────────────────────────────────────────────────
let db: InMemorySupabase;
let seq = 0;
function freshDb(options: { maxRows?: number } = {}) {
  db = createInMemorySupabase(options);
  db.seed('super_admins', [{ email: SECOND }]);
  state.db = clientOver(db);
}
function happen(at: string, title: string, kind = 'family_signup'): Row {
  const row = { id: `n-${String(++seq).padStart(6, '0')}`, kind, title, created_at: new Date(at).toISOString() };
  db.seed('admin_notifications', [row]);
  return row;
}
function seedMany(n: number, at: string, kind = 'info') {
  const iso = new Date(at).toISOString();
  // One instant and one title for all of them: the worst case for a page boundary (a tie).
  db.seed('admin_notifications', Array.from({ length: n }, () => ({ id: `bulk-${String(++seq).padStart(6, '0')}`, kind, title: 'bulk', created_at: iso })));
}
function call(authorization: string | null = `Bearer ${CRON}`) {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return GET(new Request(`https://bubaly.test${ROUTE}`, { headers }) as never);
}
async function runAt(at: string, authorization?: string | null) {
  vi.setSystemTime(new Date(at));
  const res = await call(authorization);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const recipients = () => [...new Set([...superAdminEmails(), SECOND])];
/** Addresses are aliased so no failure message prints a real one: the built-in admin is admin-1, the table's is admin-2. */
const alias = (to: string) => (to === SECOND ? 'admin-2' : `admin-${recipients().indexOf(to) + 1}`);
const count = (pick: (a: Attempt) => boolean) => {
  const out: Record<string, number> = Object.fromEntries(recipients().map((r) => [alias(r), 0]));
  for (const a of state.attempts) if (pick(a)) out[alias(a.to)] += 1;
  return out;
};
/** Provider calls the handler made, per recipient. */
const attempted = () => count(() => true);
/** Messages the FAKE provider accepted, per recipient — a folded repeat included, since the provider answers it 200. */
const accepted = () => count((a) => a.accepted);
/** Messages the FAKE provider would go on to DELIVER, per recipient: accepted and not a fold of an earlier one. This test's stand-in for delivery, not demonstrated inbox delivery. */
const delivered = () => count((a) => a.accepted && !a.folded);
/** Repeats the fake provider folded onto an earlier acceptance, per recipient. */
const folded = () => count((a) => a.folded);
/** The idempotency keys seen for one recipient, de-duplicated. */
const keysFor = (to: string) => [...new Set(state.attempts.filter((a) => a.to === to).map((a) => a.idempotencyKey))];
const each = (n: number) => Object.fromEntries(recipients().map((r) => [alias(r), n]));

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.CRON_SECRET = CRON;
  process.env.RESEND_API_KEY = RESEND_KEY;
  process.env.SUPER_ADMIN_EMAILS = '';
  state.attempts = []; state.mode = {}; state.strayNetwork = []; state.reads = {}; state.writes = []; state.keys = new Map();
  state.failRead = null; state.barrier = null; state.recipientsOverride = null;
  freshDb();
  vi.stubGlobal('fetch', vi.fn(fakeResend));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  expect(state.strayNetwork, 'no call may leave the process').toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ['CRON_SECRET', 'RESEND_API_KEY', 'SUPER_ADMIN_EMAILS']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('fixture', () => {
  it('two recipients (the built-in admin and one super_admins row), and both schedulers name 12:30 UTC', () => {
    expect(recipients()).toHaveLength(2);
    expect(SCHEDULES[ROUTE]).toBe('30 12 * * *');
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === ROUTE)?.schedule).toBe('30 12 * * *');
    // The dispatcher's five-minute look-back selects the route for a tick at 12:30–12:34, and only then.
    expect(dueRoutes(new Date('2026-09-30T12:30:00Z'))).toContain(ROUTE);
    expect(dueRoutes(new Date('2026-09-30T12:34:00Z'))).toContain(ROUTE);
    expect(dueRoutes(new Date('2026-09-30T12:35:00Z'))).not.toContain(ROUTE);
  });
});

describe('admin-digest replay: one occurrence, one key per admin, the provider folds the repeat', () => {
  // ── refusal and the no-op branches ─────────────────────────────────────────
  it('refuses every unauthorised call with 401 before touching the database or the provider', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const statuses = [
      (await runAt('2026-09-30T12:30:00Z', null)).status,
      (await runAt('2026-09-30T12:30:00Z', 'Bearer wrong-secret')).status,
      (await runAt('2026-09-30T12:30:00Z', CRON)).status, // no "Bearer "
    ];
    delete process.env.CRON_SECRET; // the production state recorded in the audit: the secret is unset
    statuses.push((await runAt('2026-09-30T12:30:00Z', 'Bearer undefined')).status);
    statuses.push((await runAt('2026-09-30T12:30:00Z', 'Bearer ')).status);
    statuses.push((await runAt('2026-09-30T12:30:00Z', `Bearer ${CRON}`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
    expect(state.reads).toEqual({});
    expect(state.attempts).toHaveLength(0);
  });

  it('a quiet day (nothing in the last 24 h) sends nothing, does not look up recipients, and answers 200', async () => {
    happen('2026-09-29T12:29:59Z', 'Just outside the window');
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res).toEqual({ status: 200, body: { ok: true, sent: 0, total: 0, reason: 'no activity in the last 24h' } });
    expect(state.reads.super_admins).toBeUndefined();
    expect(state.attempts).toHaveLength(0);
  });

  it('empty recipients answers 200 with the count and sends nothing — reachable only by replacing the lookup, because the built-in admin is always present', async () => {
    expect(superAdminEmails().length).toBeGreaterThan(0); // with SUPER_ADMIN_EMAILS empty
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    happen('2026-09-30T09:00:00Z', 'Signup Bravo');
    state.recipientsOverride = [];
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res).toEqual({ status: 200, body: { ok: true, sent: 0, total: 2, reason: 'no super-admin recipients' } });
    expect(state.attempts).toHaveLength(0);
  });

  it('a super_admins row that repeats the env allowlist in another case is one recipient, sent once', async () => {
    process.env.SUPER_ADMIN_EMAILS = SECOND;
    freshDb();
    db.seed('super_admins', [{ email: SECOND.toUpperCase() }]);
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.body).toMatchObject({ ok: true, sent: 2, recipients: 2 });
    expect(attempted()).toEqual(each(1));
  });

  it('with no RESEND_API_KEY it answers 200 ok with sent 0 and skipped 2, having delivered nothing (the JOB-EF2453D9F633 body)', async () => {
    delete process.env.RESEND_API_KEY;
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: 0, skipped: 2, failed: 0, recipients: 2, total: 1 });
    expect(state.attempts).toHaveLength(0);
  });

  // ── pagination ─────────────────────────────────────────────────────────────
  it('pages past a 1,000-row server cap: 2,345 rows in the window (all tied on created_at and title) are counted exactly, in 4 reads', async () => {
    freshDb({ maxRows: 1000 });
    seedMany(2345, '2026-09-30T10:00:00Z');
    seedMany(50, '2026-09-29T11:00:00Z'); // outside the window
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: 2, total: 2345 });
    // 1000 + 1000 + 345, then an EMPTY page proves the end (a short page is not proof).
    expect(state.reads.admin_notifications).toBe(4);
    expect(attempted()).toEqual(each(1));
  });

  it('exactly 20,000 rows is a complete read; 20,001 is a truncated one and answers 502 without looking up recipients or sending', async () => {
    seedMany(20_000, '2026-09-30T10:00:00Z');
    const full = await runAt('2026-09-30T12:30:00Z');
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ ok: true, total: 20_000 });
    expect(state.attempts).toHaveLength(2);

    state.attempts = []; state.reads = {};
    seedMany(1, '2026-09-30T10:00:00Z');
    const over = await runAt('2026-09-30T12:31:00Z');
    expect(over).toEqual({ status: 502, body: { ok: false, error: 'adminDigest.notificationFeedUnavailable' } });
    expect(state.reads.super_admins).toBeUndefined();
    expect(state.attempts).toHaveLength(0);
  });

  // ── database failures ──────────────────────────────────────────────────────
  it('a failed first page of the notification feed answers 502 and sends nothing', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    state.failRead = { table: 'admin_notifications', call: 1, how: 'error' };
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res).toEqual({ status: 502, body: { ok: false, error: 'adminDigest.notificationFeedUnavailable' } });
    expect(state.reads.super_admins).toBeUndefined();
    expect(state.attempts).toHaveLength(0);
  });

  it('a failed THIRD page discards the two good pages: 502, nothing sent', async () => {
    freshDb({ maxRows: 1000 });
    seedMany(2345, '2026-09-30T10:00:00Z');
    state.failRead = { table: 'admin_notifications', call: 3, how: 'error' };
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.status).toBe(502);
    expect(state.reads.admin_notifications).toBe(3);
    expect(state.attempts).toHaveLength(0);
  });

  // Until #685 these two answered 200 ok and emailed the built-in admin alone; that
  // observation is kept, dated, in docs/final-audit/admin-digest-replay-contract-2026-09-30/.
  for (const how of ['error', 'throw'] as const) {
    it(`a super_admins read that ${how === 'error' ? 'answers an error' : 'throws'} fails closed (#685): 502, and not one email`, async () => {
      happen('2026-09-30T08:00:00Z', 'Signup Alpha');
      state.failRead = { table: 'super_admins', call: 1, how };
      const res = await runAt('2026-09-30T12:30:00Z');
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ ok: false, error: 'adminDigest.recipientsUnavailable' });
      expect(attempted()).toEqual({ 'admin-1': 0, 'admin-2': 0 });
    });
  }

  // ── replay: the same occurrence, again ─────────────────────────────────────
  it('SEQUENTIAL REPEAT: a second call for the same 12:30 occurrence attempts every admin again under the SAME key with the SAME bytes — the provider folds it: 4 attempted, 2 delivered, nothing written', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    happen('2026-09-30T09:00:00Z', 'Paid Bravo', 'subscription');
    const first = await runAt('2026-09-30T12:30:00Z');
    const second = await runAt('2026-09-30T12:30:00Z');
    for (const r of [first, second]) {
      expect(r.status).toBe(200);
      // `sent` counts provider acceptances; a fold IS an acceptance (the provider answers 200 with the first result).
      expect(r.body).toMatchObject({ ok: true, sent: 2, failed: 0, recipients: 2, total: 2, occurrence: 'admin-digest:2026-09-30T12:30:00.000Z' });
    }
    expect(attempted()).toEqual(each(2));
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(1));
    const [a, b] = state.attempts.filter((x) => x.to === SECOND);
    expect(a.subject).toBe(b.subject);
    expect(a.html).toBe(b.html);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(keysFor(SECOND)).toHaveLength(1);
    // One key per (occurrence, recipient): the two admins never share one.
    expect(new Set(state.attempts.map((x) => x.idempotencyKey)).size).toBe(2);
    expect(state.attempts.every((x) => /^admin-digest\/[0-9a-f]{64}$/.test(x.idempotencyKey ?? ''))).toBe(true);
    expect(state.writes).toEqual([]);
  });

  it('THE MIRRORED MINUTE: Vercel at 12:30 and GitHub at 12:33 read the same window and render the same bytes; the second is folded, and the 12:31 signup waits for the next slot', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const vercel = await runAt('2026-09-30T12:30:00Z');
    happen('2026-09-30T12:31:00Z', 'Signup Charlie');
    const github = await runAt('2026-09-30T12:33:00Z');
    expect(vercel.body).toMatchObject({ ok: true, sent: 2, total: 1 });
    expect(github.body).toMatchObject({ ok: true, sent: 2, total: 1 }); // Charlie is after the slot: next occurrence's
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(1));
    const second = state.attempts.filter((x) => x.to === SECOND);
    expect(second[0].html).toBe(second[1].html);
    expect(second[1].html).toContain('Signup Alpha');
    expect(second[1].html).not.toContain('Signup Charlie');
    // The label is the slot's date, not the clock's: identical on every tick.
    expect(second[0].subject).toBe(second[1].subject);
    // The next day's slot is a new occurrence, a new key, and Charlie's digest.
    const next = await runAt('2026-10-01T12:30:00Z');
    expect(next.body).toMatchObject({ ok: true, sent: 2, total: 1, occurrence: 'admin-digest:2026-10-01T12:30:00.000Z' });
    expect(keysFor(SECOND)).toHaveLength(2);
    expect(delivered()).toEqual(each(2));
    expect(state.attempts.at(-1)!.html).toContain('Signup Charlie');
  });

  it('A LATE DISPATCH past midnight: a GitHub tick at 02:00Z the next day is still the 30 September occurrence — same window, same label, same bytes, folded', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const onTime = await runAt('2026-09-30T12:30:00Z');
    happen('2026-09-30T15:00:00Z', 'Signup Delta');
    // 13½ hours late and on the clock's NEXT day: a label from the clock would read "Oct 1" and
    // change the bytes, which the provider would refuse under the used key (409) — not fold.
    const late = await runAt('2026-10-01T02:00:00Z');
    expect(onTime.body).toMatchObject({ ok: true, sent: 2, total: 1, occurrence: 'admin-digest:2026-09-30T12:30:00.000Z' });
    expect(late.body).toMatchObject({ ok: true, sent: 2, failed: 0, total: 1, occurrence: 'admin-digest:2026-09-30T12:30:00.000Z' });
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(1));
    const [a, b] = state.attempts.filter((x) => x.to === SECOND);
    expect(a.subject).toBe(b.subject);
    expect(b.subject).toContain('Sep 30');
    expect(b.subject).not.toContain('Oct 1');
  });

  it('CONCURRENT: two workers that both finish reading before either sends attempt every admin twice; the provider accepts one of each pair and folds the other', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    vi.setSystemTime(new Date('2026-09-30T12:30:00Z'));
    barrierOn('super_admins', 2); // the first page of the last read before the send fan-out
    const [a, b] = await Promise.all([call(), call()]);
    expect(state.barrier!.arrived).toBe(2); // one first page per invocation; later pages are not counted
    expect(state.barrier!.attemptsAtRelease).toBe(0); // neither had sent when both had read
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toMatchObject({ ok: true, sent: 2 });
    expect(await b.json()).toMatchObject({ ok: true, sent: 2 });
    expect(attempted()).toEqual(each(2));
    // The fake serialises the two requests, as the provider's key store does; a real race
    // between two in-flight sends under one key is the provider's to resolve, not shown here.
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(1));
    expect(state.writes).toEqual([]); // no claim row exists to lose a race on — the key is the claim
  });

  for (const failure of ['refuse', 'network-error'] as const) {
    it(`ONE RECIPIENT FAILS (${failure}) AFTER ANOTHER SUCCEEDS: 502 {sent 1, failed 1}; the retry attempts both, and the admin who already had it is folded`, async () => {
      happen('2026-09-30T08:00:00Z', 'Signup Alpha');
      state.mode[SECOND] = failure;
      const failed = await runAt('2026-09-30T12:30:00Z');
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ ok: false, sent: 1, failed: 1, skipped: 0, recipients: 2, total: 1 });
      expect(attempted()).toEqual(each(1));
      expect(delivered()).toEqual({ 'admin-1': 1, 'admin-2': 0 });

      state.mode = {};
      const retry = await runAt('2026-09-30T12:30:00Z'); // what the 502 invites
      expect(retry.status).toBe(200);
      expect(attempted()).toEqual(each(2));
      expect(delivered()).toEqual(each(1)); // admin-1's second copy folded; admin-2's first copy delivered
      expect(folded()).toEqual({ 'admin-1': 1, 'admin-2': 0 });
      expect(state.writes).toEqual([]); // no per-recipient receipt — the provider's key store is what tells the retry
    });
  }

  it('ACCEPTED BEFORE A TIMEOUT: the provider accepts both, the handler reports one failure and 502; the retry is folded for BOTH admins', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    state.mode[SECOND] = 'accept-then-timeout';
    const first = await runAt('2026-09-30T12:30:00Z');
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ ok: false, sent: 1, failed: 1 });
    expect(accepted()).toEqual(each(1)); // reported "failed", yet the fake provider accepted it

    state.mode = {};
    await runAt('2026-09-30T12:30:00Z');
    expect(attempted()).toEqual(each(2));
    // The same key on the retry, so the provider folds the ambiguous send instead of delivering a second copy.
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(1));
    expect(keysFor(SECOND)).toHaveLength(1);
  });

  it('A CHANGED PAYLOAD under a used key is refused by the provider, not sent: the route reports the failure', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    await runAt('2026-09-30T12:30:00Z');
    // Simulate a payload drift the policy forbids (a row back-dated into the frozen window).
    happen('2026-09-30T08:30:00Z', 'Signup Backdated');
    const drifted = await runAt('2026-09-30T12:30:00Z');
    expect(drifted.status).toBe(502);
    expect(drifted.body).toMatchObject({ ok: false, sent: 0, failed: 2 });
    expect(delivered()).toEqual(each(1));
    expect(folded()).toEqual(each(0));
  });

  it('PARTIAL DELIVERY STATUS: 502 whenever any recipient fails, 200 only when none does; the body always carries the per-run counts', async () => {
    // Three OCCURRENCES (three days), because within one occurrence a provider that has accepted a key
    // answers its repeat with the first result — a refusal cannot be injected into a folded send.
    const results: { status: number; body: Record<string, unknown> }[] = [];
    const days = ['2026-09-30', '2026-10-01', '2026-10-02'];
    const modes = [{}, { [SECOND]: 'refuse' }, Object.fromEntries(recipients().map((r) => [r, 'refuse']))] as Record<string, ProviderMode>[];
    for (const [i, day] of days.entries()) {
      happen(`${day}T08:00:00Z`, `Signup ${i}`);
      state.mode = modes[i];
      results.push(await runAt(`${day}T12:30:00Z`));
    }
    expect(results.map((r) => r.status)).toEqual([200, 502, 502]);
    expect(results.map(({ body: { ok, sent, failed, skipped } }) => ({ ok, sent, failed, skipped }))).toEqual([
      { ok: true, sent: 2, failed: 0, skipped: 0 },
      { ok: false, sent: 1, failed: 1, skipped: 0 },
      { ok: false, sent: 0, failed: 2, skipped: 0 },
    ]);
    // Three occurrences: 6 attempts, nothing folded; admin-1 delivered twice (days 1 and 2), admin-2 once (day 1).
    expect(state.attempts).toHaveLength(6);
    expect(folded()).toEqual(each(0));
    expect(delivered()).toEqual({ 'admin-1': 2, 'admin-2': 1 });
  });
});

// ── Promoted from the desired contract (docs/final-audit/admin-digest-replay-contract-2026-09-30) ──
// C6 failed on main at 231e8140 and passes since #685. The cases above state what the flag-off
// path now does AS THE PROVIDER'S KEY STORE MEETS IT: one occurrence per slot, one key per admin
// per occurrence, frozen bytes, a folded repeat. The evidence folder's C1–C5 still FAIL against
// this route, deliberately left so: its fixture counts provider ACCEPTANCES and keeps no key
// store, so a folded repeat counts there as a second acceptance. Meeting C1–C5 as written — a
// retry that ATTEMPTS only the unaccepted recipient, with nothing re-sent to the provider at
// all — needs a durable per-recipient record, which is the delivery engine's (flag-gated,
// migrations 0471/0474).
describe('admin-digest contract (promoted)', () => {
  it('C6 a run that could not read its recipient list does not report a clean success', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    state.failRead = { table: 'super_admins', call: 1, how: 'error' };
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.body.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(state.attempts).toHaveLength(0);
  });
});
