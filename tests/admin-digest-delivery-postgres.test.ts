// Migrations 0471 and 0474 and the PostgreSQL DigestDeliveryStore.
//
// The first block always runs: the adapter's strictness, with a fake transport.
// Everything else needs a real database. It is opt-in (DIGEST_DELIVERY_PG=1,
// see tests/helpers/digest-delivery-postgres.ts) and SKIPPED otherwise; CI's
// Database job covers the same functions through
// docs/audit/an-admin-digest-reaches-each-admin-once-check.sql and
// docs/audit/a-removed-admin-is-not-sent-the-digest-check.sql.
//
// Synthetic data only. No provider is called: the engine tests use the fake
// provider that follows Resend's documented key semantics.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_PAYLOAD_JSON_CHARS, MAX_PROVIDER_MESSAGE_ID_CHARS, RESEND_KEY_RETENTION_MS, deliverDigestOccurrence, freezePlan,
  payloadJsonOf, recipientKeyOf, resumeDigestOccurrence,
  type BeginSendPolicy, type ClaimPolicy, type DigestDeliveryStore, type EngineConfig, type EngineDeps, type ProviderSendResult,
} from '@/lib/admin/digest-delivery';
import { createPostgresDigestDeliveryStore, parseDeliveryRow, supabaseRpc, type RpcCall } from '@/lib/admin/digest-delivery-store';
import { FakeClock, FakeResendProvider, HOUR, MINUTE, MemoryDigestDeliveryStore, deferred, never } from './helpers/digest-delivery-fakes';
import { ADMITTED, TABLE_ONLY, answerOf, contractPlan, describeDigestDeliveryStoreContract } from './helpers/digest-delivery-store-contract';
import { createPgFixture, pgFixtureEnabled, pgServerVersionNum, psql, type PgFixture } from './helpers/digest-delivery-postgres';

const T0 = '2026-09-30T12:31:00.000Z';
const MIGRATION_0471 = 'supabase/migrations/0471_an_admin_digest_reaches_each_admin_once.sql';
const OCC = 'admin-digest:2026-09-30T12:30:00.000Z';
const ONE = 'admin-one@example.test';
const TWO = 'admin-two@example.test';
const K1 = recipientKeyOf(ONE);
const CLAIM: ClaimPolicy = { leaseMs: 5 * MINUTE, maxAttempts: 4, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR };
const BEGIN: BeginSendPolicy = { minLeaseRemainingMs: 150, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR };
const CONFIG: EngineConfig = { ...CLAIM, maxAttempts: 5, sendTimeoutMs: 2_000 };
const EVERYONE: EngineDeps['eligibility'] = { allowlisted: () => true };

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
    await expect(storeAnswering('yes').store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).rejects.toThrow(/malformed/);
    await expect(storeAnswering(null).store.complete(OCC, K1, 1, { kind: 'accepted', messageId: 'm' }, 3)).rejects.toThrow(/malformed/);
    expect(await storeAnswering({ answer: 'ok', dispatchBy: '2026-09-30T12:35:59.85+00:00' }).store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).toEqual({ ok: true, dispatchBy: '2026-09-30T12:35:59.850Z' });
    for (const r of ['fenced_out', 'lease_expired', 'retention_passed', 'withdrawn']) expect(await storeAnswering({ answer: r }).store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).toEqual({ ok: false, reason: r });
    await expect(storeAnswering({ answer: 'ok' }).store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).rejects.toThrow(/malformed/); // a grant without a deadline
    await expect(storeAnswering('ok').store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).rejects.toThrow(/malformed/);
  });

  it('allowlist membership that is not a boolean never reaches the database (0474 would refuse a NULL)', async () => {
    for (const admission of [undefined, null, {}, { allowlisted: 'true' }, { allowlisted: 1 }, { allowlisted: null }]) {
      const { store, calls } = storeAnswering({ answer: 'ok', dispatchBy: '2026-09-30T12:35:59.85+00:00' });
      await expect(store.beginSend(OCC, K1, 1, BEGIN, admission as never)).rejects.toThrow(TypeError);
      expect(calls, JSON.stringify(admission)).toEqual([]);
    }
    // Controls: both booleans go through as p_allowlisted, for the database to add super_admins to.
    const { store, calls } = storeAnswering({ answer: 'withdrawn' });
    expect(await store.beginSend(OCC, K1, 1, BEGIN, ADMITTED)).toEqual({ ok: false, reason: 'withdrawn' });
    expect(await store.beginSend(OCC, K1, 1, BEGIN, TABLE_ONLY)).toEqual({ ok: false, reason: 'withdrawn' });
    expect(calls.map((c) => c[1].p_allowlisted)).toEqual([true, false]);
  });

  it('a fence that is not a non-negative integer never reaches the database', async () => {
    for (const fence of [null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      const { store, calls } = storeAnswering({ answer: 'ok', dispatchBy: '2026-09-30T12:35:59.85+00:00' });
      await expect(store.beginSend(OCC, K1, fence as never, BEGIN, ADMITTED)).rejects.toThrow(TypeError);
      await expect(store.complete(OCC, K1, fence as never, { kind: 'accepted', messageId: 'm' }, 3)).rejects.toThrow(TypeError);
      expect(calls, String(fence)).toEqual([]);
    }
    // Controls: a claim's fence, and a stale 0, go through unchanged for the database to judge.
    const { store, calls } = storeAnswering('ok');
    expect(await store.complete(OCC, K1, 7, { kind: 'accepted', messageId: 'm' }, 3)).toBe('ok');
    expect(await store.complete(OCC, K1, 0, { kind: 'accepted', messageId: 'm' }, 3)).toBe('ok');
    expect(calls.map((c) => c[1].p_fence)).toEqual([7, 0]);
  });

  it('the bounds the engine enforces are the ones 0471 declares', () => {
    const sql = readFileSync(MIGRATION_0471, 'utf8');
    expect(sql).toContain(`check (length(payload_json) between 2 and ${MAX_PAYLOAD_JSON_CHARS})`);
    expect(sql).toContain(`length(provider_message_id) between 1 and ${MAX_PROVIDER_MESSAGE_ID_CHARS})`);
  });

  it('an accepted message id the store could not hold whole is never sent to it (0471 would truncate it)', async () => {
    for (const messageId of ['x'.repeat(MAX_PROVIDER_MESSAGE_ID_CHARS + 1), '\u{1F600}'.repeat(MAX_PROVIDER_MESSAGE_ID_CHARS + 1)]) {
      const { store, calls } = storeAnswering('ok');
      await expect(store.complete(OCC, K1, 1, { kind: 'accepted', messageId }, 3)).rejects.toThrow(TypeError);
      expect(calls).toEqual([]);
    }
    // Controls: exactly at the bound, counted in characters as PostgreSQL does (an emoji is one); and an
    // empty id, which 0471 itself records as unknown, not as a receipt.
    const { store, calls } = storeAnswering('ok');
    expect(await store.complete(OCC, K1, 1, { kind: 'accepted', messageId: 'x'.repeat(MAX_PROVIDER_MESSAGE_ID_CHARS) }, 3)).toBe('ok');
    expect(await store.complete(OCC, K1, 1, { kind: 'accepted', messageId: '\u{1F600}'.repeat(MAX_PROVIDER_MESSAGE_ID_CHARS) }, 3)).toBe('ok');
    expect(await store.complete(OCC, K1, 1, { kind: 'accepted', messageId: '' }, 3)).toBe('ok');
    expect(calls).toHaveLength(3);
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

describe.skipIf(!pgFixtureEnabled)('0471 + 0474 on PostgreSQL (disposable database)', () => {
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

  describeDigestDeliveryStoreContract('postgres store (0471 + 0474)', (clock) => pgStore(clock), () => ({
    set: (emails) => fx.setAdmins(emails),
    breakTable: () => fx.breakAdmins(),
  }));

  describe('the SQL rules are the TypeScript rules (differential)', () => {
    // Every step is applied to the in-memory store (the pure TypeScript rules) and to
    // PostgreSQL (the four functions); answers and full state must agree after each one.
    // Admissions carry a random allowlist answer, and the super_admins table changes between
    // steps (0474), so withdrawal is decided by both from the same inputs.
    const mulberry = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const RESULTS: ProviderSendResult[] = [
      { kind: 'accepted', messageId: 'm-1' }, { kind: 'accepted', messageId: '' }, { kind: 'payload_conflict' }, { kind: 'in_progress' },
      { kind: 'rejected', httpStatus: 429, code: 'rate_limit_exceeded', retryable: true }, { kind: 'rejected', httpStatus: 422, code: 'validation_error', retryable: false },
      { kind: 'unknown', reason: 'timeout' }, { kind: 'unknown', reason: 'server_error' },
    ];
    const STEPS = [0, 1_000, 4 * MINUTE, 5 * MINUTE, 6 * MINUTE, 2 * HOUR, 11 * HOUR, 23 * HOUR];
    const reached = new Set<string>();
    const TABLES: readonly (readonly string[])[] = [[ONE, TWO], [ONE, TWO], [' Admin-One@Example.TEST ', TWO], [ONE], [TWO], [], ['someone-else@example.test']];

    it.each([1, 2, 3])('seed %i: 160 random steps agree exactly', async (seed) => {
      const rand = mulberry(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const clock = new FakeClock(T0);
      let admins: readonly string[] = [ONE, TWO];
      const mem = new MemoryDigestDeliveryStore(clock.now, () => admins);
      const pg = pgStore(clock);
      const frozen = freezePlan(contractPlan(), clock.now());
      await mem.freeze(frozen.occurrence, frozen.deliveries);
      await pg.freeze(frozen.occurrence, frozen.deliveries); // after pgStore's reset, which empties super_admins
      await fx.setAdmins(admins);
      const keys = frozen.occurrence.recipientKeys;
      for (let i = 0; i < 160; i += 1) {
        const key = pick(keys);
        const current = mem.row(OCC, key)!.fence;
        const fence = rand() < 0.8 ? current : Math.max(0, current - 1);
        const op = pick(['claim', 'claim', 'begin', 'begin', 'complete', 'complete', 'advance', 'admins'] as const);
        let a: unknown; let b: unknown;
        if (op === 'claim') { const owner = pick(['A', 'B']); a = await mem.claim(OCC, key, owner, CLAIM); b = await pg.claim(OCC, key, owner, CLAIM); }
        else if (op === 'begin') {
          const admission = rand() < 0.6 ? ADMITTED : TABLE_ONLY;
          a = await mem.beginSend(OCC, key, fence, BEGIN, admission); b = await pg.beginSend(OCC, key, fence, BEGIN, admission);
          reached.add(answerOf(a as never));
        }
        else if (op === 'admins') { admins = pick(TABLES); await fx.setAdmins(admins); }
        else if (op === 'complete') { const r = pick(RESULTS); a = await mem.complete(OCC, key, fence, r, CLAIM.maxAttempts); b = await pg.complete(OCC, key, fence, r, CLAIM.maxAttempts); }
        else clock.advance(pick(STEPS));
        expect(b, `step ${i} ${op} ${key.slice(0, 6)} fence ${fence}`).toEqual(a);
        expect(await pg.load(OCC), `state after step ${i}`).toEqual(await mem.load(OCC));
      }
    }, 240_000);

    it('the random steps reached a grant, a withdrawal and a fenced refusal', () => {
      expect([...reached]).toEqual(expect.arrayContaining(['ok', 'withdrawn', 'fenced_out']));
    });
  });

  describe('0474 matching does not depend on the database collation (review 5373785714)', () => {
    // PostgreSQL's lower() follows the collation. Under libc C.UTF-8 (this cluster's default), ICU tr-TR
    // and PostgreSQL 17's builtin C.UTF-8 (pg_c_utf8) it turns U+0130 into a plain "i"; under ICU und it
    // gives "i" + U+0307, as JavaScript does. The rows are written straight into the table, as legacy or
    // service-role data would be: nothing normalises them first.
    // Each case runs the migrations in a database with that collation, records the settings, and shows:
    // the removed plain-i admin is withdrawn with zero provider calls while ASCII-case, Unicode-whitespace
    // and non-ASCII identities are admitted; and the old lower() predicate would have admitted the
    // removed admin exactly where the collation folds U+0130 to "i".
    const COLLATIONS = [
      { label: 'libc C.UTF-8', create: `template template0 encoding 'UTF8' locale_provider libc locale 'C.UTF-8'`, provider: 'c', icu: '', lowerDottedI: '69' },
      { label: 'ICU und', create: `template template0 encoding 'UTF8' locale_provider icu icu_locale 'und' locale 'C.UTF-8'`, provider: 'i', icu: 'und', lowerDottedI: '69cc87' },
      { label: 'ICU tr-TR', create: `template template0 encoding 'UTF8' locale_provider icu icu_locale 'tr-TR' locale 'C.UTF-8'`, provider: 'i', icu: 'tr-TR', lowerDottedI: '69' },
      // PostgreSQL 17+ only; skipped on an older server.
      { label: 'builtin C.UTF-8 (pg_c_utf8)', create: `template template0 encoding 'UTF8' locale_provider builtin builtin_locale 'C.UTF-8' locale 'C.UTF-8'`, provider: 'b', icu: 'C.UTF-8', lowerDottedI: '69', minVersion: 170000 },
    ] as const;
    const JOSE = 'jos\u00e9@example.test';
    const TABLE = ['adm\u0130n-one@example.test', ' ADMIN-TWO@Example.TEST\u3000', JOSE]; // not admin-one; admin-two by ASCII case; jose as stored
    const sql0474 = readFileSync('supabase/migrations/0474_a_removed_admin_is_not_sent_the_digest.sql', 'utf8');
    /** The begin_send 0474 shipped before this review: the same function with lower() in the match. */
    const lowerPredicate = () => {
      const fn = sql0474.match(/create or replace function public\.admin_digest_begin_send\([\s\S]*?\nend \$\$;\n/)![0];
      const old = fn.replace("convert_to(translate(regexp_replace(s.email,", "convert_to(lower(regexp_replace(s.email,")
        .replace("'', 'g'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'UTF8')", "'', 'g')), 'UTF8')");
      expect(old).not.toBe(fn);
      return old;
    };

    // A case the server cannot run is left out, not passed vacuously.
    const serverVersion = pgServerVersionNum();
    it.each(COLLATIONS.filter((c) => !('minVersion' in c) || serverVersion >= c.minVersion))('$label', async (c) => {
      const db = await createPgFixture({ createOptions: c.create });
      try {
        // The settings this case ran under, and what lower() does to U+0130 there. The provider's locale
        // column is daticulocale on PostgreSQL 16 and datlocale from 17.
        expect(await db.sql(`select d.datlocprovider::text || '|' || d.datcollate || '|' || d.datctype || '|'
            || coalesce(to_jsonb(d) ->> 'datlocale', to_jsonb(d) ->> 'daticulocale', '') || '|' || encode(convert_to(lower(U&'\\0130'), 'UTF8'), 'hex')
          from pg_database d where d.datname = current_database();`)).toBe(`${c.provider}|C.UTF-8|C.UTF-8|${c.icu}|${c.lowerDottedI}`);
        const clock = new FakeClock(T0);
        const provider = new FakeResendProvider(clock.now);
        const run = (occurrenceId: string) => deliverDigestOccurrence(contractPlan({ occurrenceId, recipients: [ONE, TWO, JOSE] }), {
          store: createPostgresDigestDeliveryStore(db.rpc(clock.now)), provider, owner: 'w', config: CONFIG, now: clock.now,
          eligibility: { allowlisted: () => false },
        });
        await db.setAdmins(TABLE);
        const fixed = await run('admin-digest:2026-09-30T12:30:00.000Z');
        expect(fixed.statuses).toEqual({ [K1]: 'withdrawn', [recipientKeyOf(TWO)]: 'accepted', [recipientKeyOf(JOSE)]: 'accepted' });
        expect(provider.requests.filter((q) => q.to === ONE)).toEqual([]);
        // Counterfactual, on this throwaway database only: the lower() predicate.
        await db.sql(lowerPredicate());
        const old = await run('admin-digest:2026-10-01T12:30:00.000Z');
        expect(old.statuses![K1]).toBe(c.lowerDottedI === '69' ? 'accepted' : 'withdrawn');
        expect(provider.requests.filter((q) => q.to === ONE)).toHaveLength(c.lowerDottedI === '69' ? 1 : 0);
      } finally {
        await db.drop();
      }
    }, 60_000);
  });

  describe('0474 in the database itself: eligibility read after the row lock', () => {
    const setup = async () => {
      const clock = new FakeClock(T0);
      const store = pgStore(clock);
      const f = freezePlan(contractPlan({ recipients: [ONE] }), clock.now());
      await store.freeze(f.occurrence, f.deliveries);
      await fx.setAdmins([ONE]);
      const c = await store.claim(OCC, K1, 'w', CLAIM);
      if (!c.claimed) throw new Error('setup');
      return { clock, store, fence: c.row.fence, where: `occurrence_id = '${OCC}' and recipient_key = '${K1}'` };
    };

    it('only the seven-argument begin_send exists: nothing can reach a dispatch without the check', async () => {
      expect(await fx.sql(`select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc where proname = 'admin_digest_begin_send';`))
        .toBe('p_occurrence_id text, p_recipient_key text, p_fence bigint, p_min_lease_ms integer, p_retention_ms bigint, p_margin_ms bigint, p_allowlisted boolean');
    });

    it('a NULL allowlist answer is refused and writes nothing', async () => {
      const { clock, where } = await setup();
      const before = await fx.sql(`select row_to_json(d)::text from public.admin_digest_deliveries d where ${where};`);
      await expect(fx.sql(`set admin_digest.test_now = '${clock.now().toISOString()}';\nset role service_role;\nselect public.admin_digest_begin_send('${OCC}', '${K1}', 1, 150, 86400000, 3600000, null);`))
        .rejects.toThrow(/allowlist membership is required/);
      expect(await fx.sql(`select row_to_json(d)::text from public.admin_digest_deliveries d where ${where};`)).toBe(before);
    });

    // Review 5922497031: the ordering is proven only if the admission is seen BLOCKED on the holder's lock
    // before the holder commits. The holder sleeps longer than this wait may take; if the admission never
    // reaches the lock in that time, the test fails instead of passing on an unexercised order.
    const blockedBehind = (app: string) => vi.waitFor(async () => expect(await fx.sql(
      `select count(*) from pg_stat_activity a
        where a.wait_event_type = 'Lock' and a.query like '%admin_digest_begin_send%'
          and (select pid from pg_stat_activity where application_name = '${app}') = any(pg_blocking_pids(a.pid));`)).toBe('1'),
    { timeout: 3_000, interval: 20 });
    const stillOpen = (app: string) => fx.sql(`select count(*) from pg_stat_activity where application_name = '${app}' and state = 'active';`);

    it('a removal committed while the admission waits for the row lock is seen: withdrawn, not granted', async () => {
      const { clock, fence, where } = await setup();
      // The holder locks the row, removes the admin in the same transaction, and commits only after the
      // admission is blocked behind it. Eligibility read before the lock would still see the admin.
      const holder = fx.sql(`set application_name = 'removing_admin'; begin; select 1 from public.admin_digest_deliveries where ${where} for update;
        delete from public.super_admins; select pg_sleep(4); commit;`);
      await sleepingIn('removing_admin');
      const admission = reconnect(clock).beginSend(OCC, K1, fence, BEGIN, TABLE_ONLY);
      await blockedBehind('removing_admin');
      expect(await stillOpen('removing_admin')).toBe('1'); // the removal is not yet committed while the admission waits
      await holder;
      expect(answerOf(await admission)).toBe('withdrawn');
      expect(await fx.sql(`select status || ':' || last_error from public.admin_digest_deliveries where ${where};`)).toBe('withdrawn:recipient_no_longer_eligible');
    }, 30_000);

    it('control: an admin added while the admission waits is seen too, and the send is granted', async () => {
      const { clock, fence, where } = await setup();
      await fx.setAdmins([]);
      const holder = fx.sql(`set application_name = 'adding_admin'; begin; select 1 from public.admin_digest_deliveries where ${where} for update;
        insert into public.super_admins (email) values ('${ONE}'); select pg_sleep(4); commit;`);
      await sleepingIn('adding_admin');
      const admission = reconnect(clock).beginSend(OCC, K1, fence, BEGIN, TABLE_ONLY);
      await blockedBehind('adding_admin');
      expect(await stillOpen('adding_admin')).toBe('1');
      await holder;
      expect(answerOf(await admission)).toBe('ok');
    }, 30_000);

    it('a withdrawn row stays withdrawn: the guard refuses to revive it, even for the table owner', async () => {
      const { store, fence, where } = await setup();
      await fx.setAdmins([]);
      expect(answerOf(await store.beginSend(OCC, K1, fence, BEGIN, TABLE_ONLY))).toBe('withdrawn');
      await expect(fx.sql(`update public.admin_digest_deliveries set status = 'in_flight' where ${where};`)).rejects.toThrow(/stays settled/);
      await expect(fx.sql(`update public.admin_digest_deliveries set status = 'pending' where ${where};`)).rejects.toThrow(/stays settled/);
    });

    it('an unreadable super_admins fails the call inside the database, and the transaction writes nothing', async () => {
      const { clock, fence, where } = await setup();
      const before = await fx.sql(`select row_to_json(d)::text from public.admin_digest_deliveries d where ${where};`);
      await fx.breakAdmins();
      await expect(reconnect(clock).beginSend(OCC, K1, fence, BEGIN, ADMITTED)).rejects.toThrow(/super_admins/);
      expect(await fx.sql(`select row_to_json(d)::text from public.admin_digest_deliveries d where ${where};`)).toBe(before);
    });

    it('the engine on PostgreSQL: an admin removed after a failed attempt is withdrawn on the retry, and nothing more is sent', async () => {
      const clock = new FakeClock(T0);
      const provider = new FakeResendProvider(clock.now);
      provider.script = ({ n }) => (n === 1 ? { do: 'reject', status: 429, code: 'rate_limit_exceeded', retryable: true } : { do: 'accept' });
      pgStore(clock);
      await fx.reset();
      await fx.setAdmins([ONE, TWO]);
      const tableOnly: EngineDeps['eligibility'] = { allowlisted: () => false };
      const deps = (owner: string): EngineDeps => ({ store: reconnect(clock), provider, owner, config: CONFIG, now: clock.now, eligibility: tableOnly });
      const first = await deliverDigestOccurrence(contractPlan(), deps('first'));
      expect(first.complete).toBe(false);
      await fx.setAdmins([TWO]);
      clock.advance(MINUTE);
      const retry = await deliverDigestOccurrence(contractPlan(), deps('retry'));
      expect(retry).toMatchObject({ complete: true, needsAttention: [] });
      expect(retry.statuses).toEqual({ [K1]: 'withdrawn', [recipientKeyOf(TWO)]: 'accepted' });
      expect(provider.requests.filter((q) => q.to === ONE)).toHaveLength(1); // the refused first attempt only
      expect(provider.deliveredTo(ONE)).toBe(0);
    }, 30_000);
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
      expect(answerOf(await store.beginSend(OCC, K1, c.row.fence, BEGIN, ADMITTED))).toBe('ok');
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
      await store.beginSend(OCC, K1, c.row.fence, BEGIN, ADMITTED);
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
      const engine = (owner: string) => ({ store: reconnect(clock), provider, owner, config: CONFIG, now: clock.now, eligibility: EVERYONE });
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
      void deliverDigestOccurrence(contractPlan({ recipients: [ONE] }), { store: crashing, provider, owner: 'dies', config: CONFIG, now: clock.now, eligibility: EVERYONE });
      await vi.waitFor(() => expect(provider.deliveredTo(ONE)).toBe(1), { timeout: 10_000 });
      clock.advance(6 * MINUTE);
      const r = await resumeDigestOccurrence(OCC, { store: reconnect(clock), provider, owner: 'restarted', config: CONFIG, now: clock.now, eligibility: EVERYONE });
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
      `select public.admin_digest_begin_send('x', 'y', 1, 0, 86400000, 3600000, true);`,
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
      await bad(`select public.admin_digest_begin_send('x', 'y', 1, 0, 86400001, 3600000, true);`);
      await bad(`select public.admin_digest_claim('x', 'y', 'w', ${23 * HOUR}, 1, 86400000, 3600000);`);
      await bad(`select public.admin_digest_claim('x', 'y', 'w', 2147483647, 1, 86400000, 3600000);`); // the largest lease the integer parameter holds
      // Control: the longest lease that still lapses inside the retry window is accepted.
      expect(await fx.sql(`set role service_role; select public.admin_digest_claim('x', 'y', 'w', ${23 * HOUR - 1}, 1, 86400000, 3600000)::text;`)).toBe('{"reason": "not_found", "claimed": false}');
    });
  });

  describe('parity with 0471\'s bounds: what the engine admits, PostgreSQL stores', () => {
    const base = contractPlan({ recipients: [ONE] }).payload;
    const withHtml = (html: string) => contractPlan({ recipients: [ONE], payload: { ...base, html } });
    const overhead = payloadJsonOf({ from: base.from, to: ONE, subject: base.subject, html: '' }).length;
    const occurrences = () => fx.sql('select count(*) from public.admin_digest_occurrences;');

    it('review counterexample: 300,000 quotes are 300,000 bytes of HTML but 600,104 stored characters; refused before anything is stored', async () => {
      await fx.reset();
      const plan = withHtml('"'.repeat(300_000));
      expect(payloadJsonOf({ ...plan.payload, to: ONE }).length).toBeGreaterThan(600_000);
      expect(() => freezePlan(plan, new Date(T0))).toThrow(TypeError);
      const store = pgStore(new FakeClock(T0));
      await expect(deliverDigestOccurrence(plan, { store, provider: new FakeResendProvider(() => new Date(T0)), owner: 'a', config: CONFIG, now: () => new Date(T0), eligibility: EVERYONE })).rejects.toThrow(TypeError);
      expect(await occurrences()).toBe('0');
    });

    it('exactly at the bound, PostgreSQL stores it; one character over, the engine refuses it first', async () => {
      await fx.reset();
      const quotes = 100_000; // each serializes to two characters, keeping the HTML under its 512 KiB byte bound
      const atBound = withHtml('"'.repeat(quotes) + 'a'.repeat(MAX_PAYLOAD_JSON_CHARS - overhead - 2 * quotes));
      const f = freezePlan(atBound, new Date(T0));
      expect(f.deliveries[0].payloadJson.length).toBe(MAX_PAYLOAD_JSON_CHARS);
      const stored = await pgStore(new FakeClock(T0)).freeze(f.occurrence, f.deliveries);
      expect(stored.created).toBe(true);
      expect(stored.deliveries[0].payloadJson).toBe(f.deliveries[0].payloadJson);
      await fx.reset();
      const over = withHtml('"'.repeat(quotes) + 'a'.repeat(MAX_PAYLOAD_JSON_CHARS - overhead - 2 * quotes + 1));
      expect(() => freezePlan(over, new Date(T0))).toThrow(/at most 600000 characters/);
      expect(await occurrences()).toBe('0');
      // Counted as PostgreSQL counts: an emoji-bearing payload exactly at the bound in characters (but
      // longer in UTF-16 units) is admitted by the engine AND stored by the database.
      const emojis = 50_000;
      const controls = Math.floor((MAX_PAYLOAD_JSON_CHARS - overhead - emojis) / 6);
      const mixed = withHtml('\u{1F600}'.repeat(emojis) + '\u0001'.repeat(controls) + 'a'.repeat(MAX_PAYLOAD_JSON_CHARS - overhead - emojis - 6 * controls));
      const g = freezePlan(mixed, new Date(T0));
      expect((await pgStore(new FakeClock(T0)).freeze(g.occurrence, g.deliveries)).created).toBe(true);
      expect(await fx.sql(`select length(payload_json) from public.admin_digest_deliveries;`)).toBe(String(MAX_PAYLOAD_JSON_CHARS));
    }, 60_000);
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
      await expect(asService(`select public.admin_digest_begin_send('${OCC}', '${K1}', null, 150, 86400000, 3600000, true);`)).rejects.toThrow(/a fence is required/);
      expect(await rawRow()).toBe(before);
      expect((await store.load(OCC))!.deliveries[0]).toMatchObject({ status: 'in_flight', fence: 1, sendStartedAt: null, firstSendAt: null });
      expect(answerOf(await store.beginSend(OCC, K1, a.row.fence, BEGIN, ADMITTED))).toBe('ok');
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
      await store.beginSend(OCC, K1, c.row.fence, BEGIN, ADMITTED);
      await store.complete(OCC, K1, c.row.fence, { kind: 'unknown', reason: 'timeout' }, 4);
      await expect(fx.sql(`update public.admin_digest_deliveries set ambiguous = false where ${where};`)).rejects.toThrow(/only move forward/);
      await expect(fx.sql(`update public.admin_digest_deliveries set fence = 0 where ${where};`)).rejects.toThrow(/only move forward/);
      await expect(fx.sql(`update public.admin_digest_deliveries set first_send_at = first_send_at + interval '1 hour' where ${where};`)).rejects.toThrow(/only move forward/);
      const d = await store.claim(OCC, K1, 'w2', CLAIM);
      if (!d.claimed) throw new Error('setup');
      await store.beginSend(OCC, K1, d.row.fence, BEGIN, ADMITTED);
      await store.complete(OCC, K1, d.row.fence, { kind: 'accepted', messageId: 'm-1' }, 4);
      await expect(fx.sql(`update public.admin_digest_deliveries set status = 'unknown', provider_message_id = null where ${where};`)).rejects.toThrow(/stays settled/);
    });
  });
});
