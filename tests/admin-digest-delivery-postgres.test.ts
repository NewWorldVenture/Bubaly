// Migration 0471 and the PostgreSQL DigestDeliveryStore.
//
// The first block always runs: the adapter's strictness, with a fake transport.
// Everything else needs a real database. It is opt-in (DIGEST_DELIVERY_PG=1,
// see tests/helpers/digest-delivery-postgres.ts) and SKIPPED otherwise; CI's
// Database job covers the same functions through
// docs/audit/an-admin-digest-reaches-each-admin-once-check.sql.
//
// Synthetic data only. No provider is called: the engine tests use the fake
// provider that follows Resend's documented key semantics.
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RESEND_KEY_RETENTION_MS, deliverDigestOccurrence, freezePlan, recipientKeyOf, resumeDigestOccurrence,
  type BeginSendPolicy, type ClaimPolicy, type DigestDeliveryStore, type EngineConfig, type ProviderSendResult,
} from '@/lib/admin/digest-delivery';
import { createPostgresDigestDeliveryStore, parseDeliveryRow, supabaseRpc, type RpcCall } from '@/lib/admin/digest-delivery-store';
import { FakeClock, FakeResendProvider, HOUR, MINUTE, MemoryDigestDeliveryStore, deferred, never } from './helpers/digest-delivery-fakes';
import { answerOf, contractPlan, describeDigestDeliveryStoreContract } from './helpers/digest-delivery-store-contract';
import { createPgFixture, pgFixtureEnabled, psql, type PgFixture } from './helpers/digest-delivery-postgres';

const T0 = '2026-09-30T12:31:00.000Z';
const OCC = 'admin-digest:2026-09-30T12:30:00.000Z';
const ONE = 'admin-one@example.test';
const TWO = 'admin-two@example.test';
const K1 = recipientKeyOf(ONE);
const CLAIM: ClaimPolicy = { leaseMs: 5 * MINUTE, maxAttempts: 4, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR };
const BEGIN: BeginSendPolicy = { minLeaseRemainingMs: 150, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR };
const CONFIG: EngineConfig = { ...CLAIM, maxAttempts: 5, sendTimeoutMs: 2_000 };

// ── the adapter, strict about what it reads (always runs) ──────────────────

describe('PostgreSQL adapter: strict mapping (fake transport)', () => {
  const row = (over: Record<string, unknown> = {}) => {
    const d = freezePlan(contractPlan({ recipients: [ONE] }), new Date(T0)).deliveries[0];
    return {
      occurrenceId: d.occurrenceId, recipientKey: d.recipientKey, idempotencyKey: d.idempotencyKey, payloadJson: d.payloadJson,
      payloadHash: d.payloadHash, status: 'in_flight', attempts: 1, fence: 1, leaseOwner: 'w', leaseExpiresAt: '2026-09-30T12:36:00.123456+00:00',
      sendStartedAt: null, firstSendAt: null, ambiguous: false, providerMessageId: null, lastError: null, updatedAt: '2026-09-30T12:31:00+00:00', ...over,
    };
  };
  const storeAnswering = (answer: unknown) => {
    const calls: [string, Record<string, unknown>][] = [];
    const rpc: RpcCall = async (fn, args) => { calls.push([fn, args]); return answer; };
    return { store: createPostgresDigestDeliveryStore(rpc), calls };
  };

  it('reads database timestamps as the engine writes them', () => {
    expect(parseDeliveryRow(row())).toMatchObject({ leaseExpiresAt: '2026-09-30T12:36:00.123Z', updatedAt: '2026-09-30T12:31:00.000Z' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown status', { status: 'sent' }],
    ['a fence that is not a count', { fence: -1 }],
    ['a non-boolean ambiguity', { ambiguous: 'no' }],
    ['bytes that are not the canonical serialization', { payloadJson: JSON.stringify({ to: ONE, from: 'x', subject: 's', html: 'h' }) }],
    ['a timestamp that is not one', { leaseExpiresAt: 'soon' }],
  ])('refuses a row with %s', (_n, over) => {
    expect(() => parseDeliveryRow(row(over))).toThrow(/malformed/);
  });

  it('a claim is believed only if the row came back in flight under OUR name', async () => {
    await expect(storeAnswering({ claimed: true, row: row({ leaseOwner: 'someone-else' }) }).store.claim(OCC, K1, 'w', CLAIM)).rejects.toThrow(/malformed/);
    await expect(storeAnswering({ claimed: true, row: row({ status: 'pending', leaseOwner: null, leaseExpiresAt: null }) }).store.claim(OCC, K1, 'w', CLAIM)).rejects.toThrow(/malformed/);
    await expect(storeAnswering({ claimed: false, reason: 'maybe' }).store.claim(OCC, K1, 'w', CLAIM)).rejects.toThrow(/malformed/);
  });

  it('beginSend and complete accept only their documented answers', async () => {
    await expect(storeAnswering('yes').store.beginSend(OCC, K1, 1, BEGIN)).rejects.toThrow(/malformed/);
    await expect(storeAnswering(null).store.complete(OCC, K1, 1, { kind: 'accepted', messageId: 'm' }, 3)).rejects.toThrow(/malformed/);
    expect(await storeAnswering({ answer: 'ok', dispatchBy: '2026-09-30T12:35:59.85+00:00' }).store.beginSend(OCC, K1, 1, BEGIN)).toEqual({ ok: true, dispatchBy: '2026-09-30T12:35:59.850Z' });
    for (const r of ['fenced_out', 'lease_expired', 'retention_passed']) expect(await storeAnswering({ answer: r }).store.beginSend(OCC, K1, 1, BEGIN)).toEqual({ ok: false, reason: r });
    await expect(storeAnswering({ answer: 'ok' }).store.beginSend(OCC, K1, 1, BEGIN)).rejects.toThrow(/malformed/); // a grant without a deadline
    await expect(storeAnswering('ok').store.beginSend(OCC, K1, 1, BEGIN)).rejects.toThrow(/malformed/);
  });

  it('a fence that is not a non-negative integer never reaches the database', async () => {
    for (const fence of [null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      const { store, calls } = storeAnswering({ answer: 'ok', dispatchBy: '2026-09-30T12:35:59.85+00:00' });
      await expect(store.beginSend(OCC, K1, fence as never, BEGIN)).rejects.toThrow(TypeError);
      await expect(store.complete(OCC, K1, fence as never, { kind: 'accepted', messageId: 'm' }, 3)).rejects.toThrow(TypeError);
      expect(calls, String(fence)).toEqual([]);
    }
    // Controls: a claim's fence, and a stale 0, go through unchanged for the database to judge.
    const { store, calls } = storeAnswering('ok');
    expect(await store.complete(OCC, K1, 7, { kind: 'accepted', messageId: 'm' }, 3)).toBe('ok');
    expect(await store.complete(OCC, K1, 0, { kind: 'accepted', messageId: 'm' }, 3)).toBe('ok');
    expect(calls.map((c) => c[1].p_fence)).toEqual([7, 0]);
  });

  it('freeze sends only identity and bytes, never a state', async () => {
    const f = freezePlan(contractPlan({ recipients: [ONE] }), new Date(T0));
    const { store, calls } = storeAnswering({ created: true, occurrence: { ...f.occurrence }, deliveries: [row({ status: 'pending', attempts: 0, fence: 0, leaseOwner: null, leaseExpiresAt: null })] });
    await store.freeze(f.occurrence, f.deliveries.map((d) => ({ ...d, status: 'accepted' as const, providerMessageId: 'forged' })));
    expect(calls[0][0]).toBe('admin_digest_freeze');
    expect(Object.keys((calls[0][1].p_deliveries as object[])[0]).sort()).toEqual(['idempotencyKey', 'occurrenceId', 'payloadHash', 'payloadJson', 'recipientKey']);
  });

  it('the Supabase transport throws on an error instead of returning it', async () => {
    const rpc = supabaseRpc({ rpc: async () => ({ data: null, error: { message: 'permission denied for function admin_digest_claim' } }) });
    await expect(rpc('admin_digest_claim', {})).rejects.toThrow('digest-delivery store: admin_digest_claim failed');
    const ok = supabaseRpc({ rpc: async () => ({ data: 'ok', error: null }) });
    expect(await ok('admin_digest_complete', {})).toBe('ok');
  });
});

// ── against a real, disposable PostgreSQL database ─────────────────────────

describe.skipIf(!pgFixtureEnabled)('0471 on PostgreSQL (disposable database)', () => {
  let fx: PgFixture;
  beforeAll(async () => { fx = await createPgFixture(); }, 60_000);
  afterAll(async () => { await fx?.drop(); }, 60_000);

  /** A PostgreSQL store on a freshly emptied database, whose clock follows `clock`. */
  const pgStore = (clock?: FakeClock): DigestDeliveryStore => {
    const ready = fx.reset();
    const rpc = fx.rpc(clock?.now);
    return createPostgresDigestDeliveryStore(async (fn, args) => { await ready; return rpc(fn, args); });
  };
  /** A second store on the SAME data: a new process, new connections. */
  const reconnect = (clock?: FakeClock): DigestDeliveryStore => createPostgresDigestDeliveryStore(fx.rpc(clock?.now));

  /** Wait until the backend named `app` is inside `select pg_sleep(...)`, i.e. past every statement before it. */
  const sleepingIn = (app: string) => vi.waitFor(async () => expect(await fx.sql(
    `select count(*) from pg_stat_activity where application_name = '${app}' and state = 'active' and query like 'select pg_sleep%';`)).toBe('1'),
  { timeout: 5_000, interval: 20 });

  describeDigestDeliveryStoreContract('postgres store (0471)', (clock) => pgStore(clock));

  describe('the SQL rules are the TypeScript rules (differential)', () => {
    // Every step is applied to the in-memory store (the pure TypeScript rules) and to
    // PostgreSQL (the four functions); answers and full state must agree after each one.
    const mulberry = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const RESULTS: ProviderSendResult[] = [
      { kind: 'accepted', messageId: 'm-1' }, { kind: 'accepted', messageId: '' }, { kind: 'payload_conflict' }, { kind: 'in_progress' },
      { kind: 'rejected', httpStatus: 429, code: 'rate_limit_exceeded', retryable: true }, { kind: 'rejected', httpStatus: 422, code: 'validation_error', retryable: false },
      { kind: 'unknown', reason: 'timeout' }, { kind: 'unknown', reason: 'server_error' },
    ];
    const STEPS = [0, 1_000, 4 * MINUTE, 5 * MINUTE, 6 * MINUTE, 2 * HOUR, 11 * HOUR, 23 * HOUR];

    it.each([1, 2, 3])('seed %i: 160 random steps agree exactly', async (seed) => {
      const rand = mulberry(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const clock = new FakeClock(T0);
      const mem = new MemoryDigestDeliveryStore(clock.now);
      const pg = pgStore(clock);
      const frozen = freezePlan(contractPlan(), clock.now());
      await mem.freeze(frozen.occurrence, frozen.deliveries);
      await pg.freeze(frozen.occurrence, frozen.deliveries);
      const keys = frozen.occurrence.recipientKeys;
      for (let i = 0; i < 160; i += 1) {
        const key = pick(keys);
        const current = mem.row(OCC, key)!.fence;
        const fence = rand() < 0.8 ? current : Math.max(0, current - 1);
        const op = pick(['claim', 'claim', 'begin', 'begin', 'complete', 'complete', 'advance'] as const);
        let a: unknown; let b: unknown;
        if (op === 'claim') { const owner = pick(['A', 'B']); a = await mem.claim(OCC, key, owner, CLAIM); b = await pg.claim(OCC, key, owner, CLAIM); }
        else if (op === 'begin') { a = await mem.beginSend(OCC, key, fence, BEGIN); b = await pg.beginSend(OCC, key, fence, BEGIN); }
        else if (op === 'complete') { const r = pick(RESULTS); a = await mem.complete(OCC, key, fence, r, CLAIM.maxAttempts); b = await pg.complete(OCC, key, fence, r, CLAIM.maxAttempts); }
        else clock.advance(pick(STEPS));
        expect(b, `step ${i} ${op} ${key.slice(0, 6)} fence ${fence}`).toEqual(a);
        expect(await pg.load(OCC), `state after step ${i}`).toEqual(await mem.load(OCC));
      }
    }, 240_000);
  });

  describe('concurrency, crashes and restarts', () => {
    it('forty concurrent claims of one delivery from forty connections: exactly one wins', async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan(), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reconnect(clock).claim(OCC, K1, `w${i}`, CLAIM)));
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      expect(results.filter((r) => !r.claimed && r.reason === 'leased')).toHaveLength(39);
      expect((await store.load(OCC))!.deliveries.find((d) => d.recipientKey === K1)).toMatchObject({ fence: 1, attempts: 1, status: 'in_flight' });
    }, 60_000);

    it('database time is read AFTER the row lock: a claim that waited past a lease sees it expired (now() would not)', async () => {
      const store = pgStore(); // the real clock
      const f = freezePlan(contractPlan({ recipients: [ONE] }), new Date());
      await store.freeze(f.occurrence, f.deliveries);
      const where = `occurrence_id = '${OCC}' and recipient_key = '${K1}'`;
      const holdThenClaim = async () => {
        await fx.sql(`update public.admin_digest_deliveries set lease_expires_at = clock_timestamp() + interval '800 milliseconds' where ${where};`);
        const holder = fx.sql(`set application_name = 'lock_holder'; begin; select 1 from public.admin_digest_deliveries where ${where} for update; select pg_sleep(1.6); commit;`);
        await sleepingIn('lock_holder'); // it holds the row lock
        const claimed = await reconnect().claim(OCC, K1, 'waiter', CLAIM); // blocks until the holder commits
        await holder;
        return claimed;
      };
      expect((await reconnect().claim(OCC, K1, 'first', CLAIM)).claimed).toBe(true);
      const afterLock = await holdThenClaim();
      expect(afterLock).toMatchObject({ claimed: true, row: { fence: 2, leaseOwner: 'waiter' } });
      // The counterfactual, on this throwaway database only: with transaction-start time the same wait says "leased".
      const original = await fx.sql(`select pg_get_functiondef('public.admin_digest_now()'::regprocedure);`);
      await fx.sql(`create or replace function public.admin_digest_now() returns timestamptz language sql volatile set search_path = public, pg_temp as $$ select now() $$;`);
      try {
        expect(await holdThenClaim()).toEqual({ claimed: false, reason: 'leased' });
      } finally {
        await fx.sql(`${original};`);
      }
    }, 30_000);

    it('a claim whose backend dies before commit leaves nothing behind', async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan({ recipients: [ONE] }), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      const dying = psql(fx.db, `set application_name = 'doomed_claim'; set admin_digest.test_now = '${T0}'; set role service_role; begin;
        select public.admin_digest_claim('${OCC}', '${K1}', 'doomed', 300000, 4, ${RESEND_KEY_RETENTION_MS}, ${HOUR}); select pg_sleep(30); commit;`).catch((e: Error) => e);
      await sleepingIn('doomed_claim'); // the claim has run inside the open transaction
      await fx.sql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'doomed_claim';`);
      expect(await dying).toBeInstanceOf(Error);
      expect((await reconnect(clock).load(OCC))!.deliveries[0]).toMatchObject({ status: 'pending', fence: 0, attempts: 0 });
    }, 30_000);

    it('a receipt whose backend dies before commit is not durable; the next claim treats the send as possibly made', async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan({ recipients: [ONE] }), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      const c = await store.claim(OCC, K1, 'w', CLAIM);
      if (!c.claimed) throw new Error('setup');
      expect(answerOf(await store.beginSend(OCC, K1, c.row.fence, BEGIN))).toBe('ok');
      const dying = psql(fx.db, `set application_name = 'doomed_receipt'; set admin_digest.test_now = '${T0}'; set role service_role; begin;
        select public.admin_digest_complete('${OCC}', '${K1}', 1, '{"kind":"accepted","messageId":"m-lost"}'::jsonb, 4); select pg_sleep(30); commit;`).catch((e: Error) => e);
      await sleepingIn('doomed_receipt'); // the receipt has been written inside the open transaction
      await fx.sql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'doomed_receipt';`);
      await dying;
      expect((await reconnect(clock).load(OCC))!.deliveries[0]).toMatchObject({ status: 'in_flight', providerMessageId: null });
      clock.advance(5 * MINUTE);
      const again = await reconnect(clock).claim(OCC, K1, 'next', CLAIM);
      expect(again).toMatchObject({ claimed: true, row: { ambiguous: true, fence: 2, firstSendAt: T0 } });
    }, 30_000);

    it.skipIf(!process.env.DIGEST_DELIVERY_PG_RESTART_CMD)('a committed receipt survives an immediate (crash) restart of the server', async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan({ recipients: [ONE] }), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      const c = await store.claim(OCC, K1, 'w', CLAIM);
      if (!c.claimed) throw new Error('setup');
      await store.beginSend(OCC, K1, c.row.fence, BEGIN);
      expect(await store.complete(OCC, K1, c.row.fence, { kind: 'accepted', messageId: 'm-durable' }, 4)).toBe('ok');
      execSync(process.env.DIGEST_DELIVERY_PG_RESTART_CMD!, { stdio: 'ignore' });
      await vi.waitFor(async () => expect(await fx.sql('select 1;')).toBe('1'), { timeout: 30_000, interval: 250 });
      expect((await reconnect(clock).load(OCC))!.deliveries[0]).toMatchObject({ status: 'accepted', providerMessageId: 'm-durable' });
    }, 60_000);

    it('the engine on PostgreSQL: two instances at once, each recipient once', async () => {
      const clock = new FakeClock(T0);
      const provider = new FakeResendProvider(clock.now);
      const gate = deferred();
      provider.script = () => ({ do: 'delay_before_arrival', until: gate.promise, then: { do: 'accept' } });
      pgStore(clock);
      const engine = (owner: string) => ({ store: reconnect(clock), provider, owner, config: CONFIG, now: clock.now });
      await fx.reset();
      const a = deliverDigestOccurrence(contractPlan(), engine('instance-a'));
      const b = deliverDigestOccurrence(contractPlan(), engine('instance-b'));
      await vi.waitFor(() => expect(provider.requests).toHaveLength(2), { timeout: 10_000 });
      gate.resolve();
      const [ra, rb] = await Promise.all([a, b]);
      expect(provider.inbox.map((d) => d.to).sort()).toEqual([ONE, TWO]);
      expect(ra.attempts.length + rb.attempts.length).toBe(2);
      expect(ra.complete || rb.complete).toBe(true);
    }, 30_000);

    it('the engine on PostgreSQL: crash after the provider accepted, then a new process resumes from the database alone', async () => {
      const clock = new FakeClock(T0);
      const provider = new FakeResendProvider(clock.now);
      const base = pgStore(clock);
      const crashing: DigestDeliveryStore = { ...base, complete: () => never() }; // the process dies before any receipt
      void deliverDigestOccurrence(contractPlan({ recipients: [ONE] }), { store: crashing, provider, owner: 'dies', config: CONFIG, now: clock.now });
      await vi.waitFor(() => expect(provider.deliveredTo(ONE)).toBe(1), { timeout: 10_000 });
      clock.advance(6 * MINUTE);
      const r = await resumeDigestOccurrence(OCC, { store: reconnect(clock), provider, owner: 'restarted', config: CONFIG, now: clock.now });
      expect(r.complete).toBe(true);
      expect(provider.deliveredTo(ONE)).toBe(1);
      const toOne = provider.requests.filter((q) => q.to === ONE);
      expect(toOne).toHaveLength(2);
      expect(new Set(toOne.map((q) => `${q.key}|${q.payloadJson}`)).size).toBe(1);
      expect((await reconnect(clock).load(OCC))!.deliveries[0]).toMatchObject({ status: 'accepted', ambiguous: true, providerMessageId: provider.inbox[0].messageId });
    }, 30_000);
  });

  describe('access: the service role through the functions, nobody else, nothing direct', () => {
    const denied = (role: string, stmt: string) => expect(fx.sql(`set role ${role}; ${stmt}`)).rejects.toThrow(/permission denied/);
    const CALLS = [
      `select public.admin_digest_load('x');`,
      `select public.admin_digest_freeze('{}'::jsonb, '[]'::jsonb);`,
      `select public.admin_digest_claim('x', 'y', 'w', 1000, 1, 86400000, 3600000);`,
      `select public.admin_digest_begin_send('x', 'y', 1, 0, 86400000, 3600000);`,
      `select public.admin_digest_complete('x', 'y', 1, '{"kind":"unknown"}'::jsonb, 1);`,
    ];
    const TABLE_STATEMENTS = [
      'select * from public.admin_digest_deliveries;',
      'select * from public.admin_digest_occurrences;',
      `insert into public.admin_digest_occurrences (occurrence_id, window_start, window_end, recipient_keys, payload_hash, engine_version, frozen_at) values ('x', now(), now() + interval '1 day', array['${'a'.repeat(64)}'], '${'b'.repeat(64)}', 1, now());`,
      `update public.admin_digest_deliveries set status = 'accepted';`,
      'delete from public.admin_digest_deliveries;',
    ];
    it.each(['anon', 'authenticated'])('%s can neither read, write nor call anything', async (role) => {
      for (const s of [...TABLE_STATEMENTS, ...CALLS]) await denied(role, s);
    }, 30_000);
    it('service_role cannot touch the tables directly, nor call the internal clock', async () => {
      for (const s of TABLE_STATEMENTS) await denied('service_role', s);
      await denied('service_role', 'select public.admin_digest_now();');
    }, 30_000);
    it('service_role can call the five functions', async () => {
      await fx.reset();
      expect(await fx.sql(`set role service_role; ${CALLS[0]}`)).toBe('');
      expect(await fx.sql(`set role service_role; select public.admin_digest_claim('x', 'y', 'w', 1000, 1, 86400000, 3600000)::text;`)).toBe('{"reason": "not_found", "claimed": false}');
    });
    it('the functions refuse a policy the engine refuses: retention past the verified 24 h, a lease that outlasts the retry window', async () => {
      const bad = (stmt: string) => expect(fx.sql(`set role service_role; ${stmt}`)).rejects.toThrow(/bad owner, lease, attempts or retention|bad lease or retention/);
      await bad(`select public.admin_digest_claim('x', 'y', 'w', 1000, 1, 86400001, 3600000);`);
      await bad(`select public.admin_digest_begin_send('x', 'y', 1, 0, 86400001, 3600000);`);
      await bad(`select public.admin_digest_claim('x', 'y', 'w', ${23 * HOUR}, 1, 86400000, 3600000);`);
      await bad(`select public.admin_digest_claim('x', 'y', 'w', 2147483647, 1, 86400000, 3600000);`); // the largest lease the integer parameter holds
      // Control: the longest lease that still lapses inside the retry window is accepted.
      expect(await fx.sql(`set role service_role; select public.admin_digest_claim('x', 'y', 'w', ${23 * HOUR - 1}, 1, 86400000, 3600000)::text;`)).toBe('{"reason": "not_found", "claimed": false}');
    });
  });

  describe('frozen means frozen, in the database itself', () => {
    const setup = async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan({ recipients: [ONE] }), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      return { clock, store, f, where: `occurrence_id = '${OCC}' and recipient_key = '${K1}'` };
    };
    it('bytes, key and recipient never change; rows are never deleted', async () => {
      const { where } = await setup();
      await expect(fx.sql(`update public.admin_digest_deliveries set payload_json = replace(payload_json, '2 new', '9 new') where ${where};`)).rejects.toThrow(/keeps its recipient, key and bytes/);
      await expect(fx.sql(`update public.admin_digest_deliveries set idempotency_key = 'bubaly/rotated' where ${where};`)).rejects.toThrow(/keeps its recipient, key and bytes/);
      await expect(fx.sql(`delete from public.admin_digest_deliveries where ${where};`)).rejects.toThrow(/never deleted/);
      await expect(fx.sql(`update public.admin_digest_occurrences set window_end = window_end + interval '1 day';`)).rejects.toThrow(/never changed or deleted/);
      await expect(fx.sql(`delete from public.admin_digest_occurrences;`)).rejects.toThrow(/never changed or deleted/);
    });
    it('a NULL fence is refused by begin_send and complete, and writes nothing', async () => {
      const { clock, store, where } = await setup();
      const a = await store.claim(OCC, K1, 'a', CLAIM);
      if (!a.claimed) throw new Error('setup');
      // Direct calls carry the same pinned clock as the adapter, so the lease is live and the old,
      // NULL-blind comparison would really have marked or completed: the refusal is what stops it.
      const asService = (call: string) => fx.sql(`set admin_digest.test_now = '${clock.now().toISOString()}';\nset role service_role;\n${call}`);
      const rawRow = () => fx.sql(`select row_to_json(d)::text from public.admin_digest_deliveries d where ${where};`);
      const before = await rawRow();
      await expect(asService(`select public.admin_digest_begin_send('${OCC}', '${K1}', null, 150, 86400000, 3600000);`)).rejects.toThrow(/a fence is required/);
      expect(await rawRow()).toBe(before);
      expect((await store.load(OCC))!.deliveries[0]).toMatchObject({ status: 'in_flight', fence: 1, sendStartedAt: null, firstSendAt: null });
      expect(answerOf(await store.beginSend(OCC, K1, a.row.fence, BEGIN))).toBe('ok');
      const marked = await rawRow();
      await expect(asService(`select public.admin_digest_complete('${OCC}', '${K1}', null, '{"kind":"accepted","messageId":"msg-forged"}'::jsonb, 4);`)).rejects.toThrow(/a fence is required/);
      expect(await rawRow()).toBe(marked);
      expect(await fx.sql(`select count(*) from public.admin_digest_deliveries where ${where} and provider_message_id is not null;`)).toBe('0');
      // Control: the claim's own fence still completes.
      expect(await store.complete(OCC, K1, a.row.fence, { kind: 'accepted', messageId: 'msg-1' }, 4)).toBe('ok');
    });

    it('an insert whose hash, recipient key or idempotency key disagrees with its bytes is refused', async () => {
      const { f } = await setup();
      const d = f.deliveries[0];
      const other = 'admin-digest:2026-10-01T12:30:00.000Z';
      await fx.sql(`insert into public.admin_digest_occurrences (occurrence_id, window_start, window_end, recipient_keys, payload_hash, engine_version, frozen_at) values ('${other}', now(), now() + interval '1 day', array['${d.recipientKey}'], '${d.payloadHash}', 1, now());`);
      const ins = (hash: string, key: string, rk = d.recipientKey) => fx.sql(`insert into public.admin_digest_deliveries (occurrence_id, recipient_key, idempotency_key, payload_json, payload_hash, status, updated_at) values ('${other}', '${rk}', '${key}', $j$${d.payloadJson}$j$, '${hash}', 'pending', now());`);
      await expect(ins('0'.repeat(64), d.idempotencyKey)).rejects.toThrow(/payload_hash is not the sha256/);
      await expect(ins(d.payloadHash, d.idempotencyKey, 'f'.repeat(64))).rejects.toThrow(/recipient_key is not the sha256/);
      await expect(ins(d.payloadHash, d.idempotencyKey)).rejects.toThrow(/idempotency_key is not the key/); // the key names the OTHER occurrence
    });
    it('a settled row stays settled; attempts, fence, ambiguity and the anchor only move forward', async () => {
      const { store, where } = await setup();
      const c = await store.claim(OCC, K1, 'w', CLAIM);
      if (!c.claimed) throw new Error('setup');
      await store.beginSend(OCC, K1, c.row.fence, BEGIN);
      await store.complete(OCC, K1, c.row.fence, { kind: 'unknown', reason: 'timeout' }, 4);
      await expect(fx.sql(`update public.admin_digest_deliveries set ambiguous = false where ${where};`)).rejects.toThrow(/only move forward/);
      await expect(fx.sql(`update public.admin_digest_deliveries set fence = 0 where ${where};`)).rejects.toThrow(/only move forward/);
      await expect(fx.sql(`update public.admin_digest_deliveries set first_send_at = first_send_at + interval '1 hour' where ${where};`)).rejects.toThrow(/only move forward/);
      const d = await store.claim(OCC, K1, 'w2', CLAIM);
      if (!d.claimed) throw new Error('setup');
      await store.beginSend(OCC, K1, d.row.fence, BEGIN);
      await store.complete(OCC, K1, d.row.fence, { kind: 'accepted', messageId: 'm-1' }, 4);
      await expect(fx.sql(`update public.admin_digest_deliveries set status = 'unknown', provider_message_id = null where ${where};`)).rejects.toThrow(/stays settled/);
    });
  });
});
