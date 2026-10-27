// A leave, or a scope switched off, while a nightly aggregation is running.
//
// N8-withdrawal-during-run (round 4, owner review on PR #1131). The run reads
// consent first, builds every family's contribution, upserts it, and only then
// claims the publication (NETWORK_PUBLICATION_LEASE_KEY). The leave never took
// that claim. So a family could leave after the run had read its consent: the
// module wrote enabled=false, deleted the stored row and said "Left the
// network" — and the run then upserted the row again and, with no snapshot of
// the epoch standing yet, counted the family in a NEW publication written
// after the family had been told it had left.
//
// Now the leave and a contributing scope's switch-off go through the server
// (withdrawFromNetworkAction) and hold the same claim around the consent write
// and the delete; the run re-reads consent after its upserts — under the claim
// when it publishes — and drops and deletes any family that withdrew.
//
// Everything below is real: the IntelligenceModule on hook slots, its server
// action, and runNetworkAggregation, against one in-memory database. One side
// is paused on a chosen statement while the other runs, which is exactly the
// interleaving two requests can produce. A gap the run's claim covers makes
// the leave wait; every other gap leaves the family out of the publication and
// out of storage. A family that did not withdraw is published every time.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemoryOptions, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { at } from './helpers/source-order';

type DB = SupabaseClient<Database>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
/** The clients the action gets: the member's own, and the service one for the claim. */
const wires = vi.hoisted(() => ({ user: null as unknown, service: null as unknown }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId, email: null },
    active: { familyId: h.app.familyId, role: (h.app as { role?: string }).role ?? 'parent', member: { id: `${h.app.familyId}-p` }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => wires.user, createServiceClient: () => wires.service }));

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');
const {
  runNetworkAggregation, NETWORK_PUBLICATION_LEASE_KEY, RUN_CLAIM_ATTEMPTS, RUN_WAITS_FOR_A_WITHDRAWAL_ATTEMPTS,
} = await import('@/lib/network/aggregate-server');
const { WITHDRAWAL_CLAIM_ATTEMPTS, WITHDRAWAL_CLAIMS_PER_WINDOW } = await import('@/lib/network/withdrawal-server');
const { withdrawFromNetworkAction } = await import('@/app/(app)/dashboard/intelligence/actions');
const { rateLimitHit } = await import('./helpers/rate-limit-rpc');

const NOW = new Date('2026-09-08T03:00:00Z');
const NEXT_NIGHT = new Date('2026-09-09T03:00:00Z');
const LEAVER = 'f-0';
const JOIN = 'Join the network';
const BENCHMARKS = 'Gentle benchmarks';
const LEFT = 'Left the network. Your data is no longer used and your stored contribution is deleted. Summaries already published this month keep your share, mixed with at least 20 families and noise, until next month’s update.';
const LEFT_WHILE_PUBLISHING = 'Left the network. Your data is no longer used and your stored contribution is deleted. A monthly update may have been in progress at that moment and may still include your share, mixed with at least 20 families and noise, until next month’s update.';

type Scopes = Record<string, boolean>;
let db: InMemorySupabase;
/** Every statement that reached the database, as `actor:table.verb`, in order. */
let events: string[];

const fresh = (rpc?: InMemoryOptions['rpc']) => createInMemorySupabase({
  uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']], app_settings: [['key']] },
  ...(rpc ? { rpc } : {}),
});

/** 145 consenting households, the leaver among them, as overlapping-runs uses. */
function seedNetwork(target: InMemorySupabase, leaver: Scopes | null = { benchmarks: true }) {
  const household = (id: string, scopes: Scopes | null, kid = true) => {
    target.seed('families', [{ id, closed_at: null, timezone: 'UTC' }]);
    if (scopes) target.seed('network_consent', [{ family_id: id, enabled: true, scopes, consented_by: null }]);
    target.seed('family_members', [
      { id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true },
      ...(kid ? [{ id: `${id}-k`, family_id: id, user_id: null, role: 'child', birthday: '2018-06-01', is_active: true }] : []),
    ]);
  };
  household(LEAVER, leaver);
  for (let i = 1; i < 120; i++) household(`f-${i}`, { benchmarks: true });
  for (let i = 0; i < 25; i++) household(`nokid-${i}`, { benchmarks: true }, false);
}

/** Every published cell → its noised count and true size, as a reader would take them. */
const published = (from: InMemorySupabase = db) => new Map(from.table('network_aggregates')
  .map((r) => [`${r.cohort_key}|${r.metric}|${r.value}`, `${r.count}/${r.cohort_size}`]));

/** What one run at NOW publishes when the leaver's consent is `leaver` from the start. */
async function publicationWith(leaver: Scopes | null) {
  const control = fresh();
  seedNetwork(control, leaver);
  expect(await runNetworkAggregation(control as unknown as DB, NOW)).toMatchObject({ ok: true, held: false });
  return published(control);
}

const stored = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);
const consentOf = (familyId: string) => db.table('network_consent').find((r) => r.family_id === familyId);
const screen = () => render(h.hooks, createElement(IntelligenceModule, {}));

/** `familyId`: only the write of that family's row (its upsert's `family_id`). */
type Hold = { table: string; method: string; familyId?: string };
const WRITES = ['insert', 'upsert', 'update', 'delete'];
const TRANSPORT_ERROR = { data: null, error: { message: 'connection reset', code: 'XX000' } };

/**
 * The database as one actor sees it. Every statement it sends is logged when
 * it lands; `pause` holds back its first statement on `table` that called
 * `method` (`reached` settles when the actor gets there, and the statement is
 * sent only after `release()`); `fail` answers every matching statement with
 * a transport error instead; `lose` sends it, so it lands, and then answers
 * with that error, as a reply lost on the way back does. `pauseWrite: n`
 * holds back the actor's n-th write instead, whatever table it is on.
 */
function wire(actor: string, opts: { pause?: Hold; pauseWrite?: number; fail?: Hold | Hold[]; lose?: Hold } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let held = false;
  let writes = 0;
  const matches = (hold: Hold | Hold[] | undefined, table: string, calls: string[], row: unknown): boolean => {
    if (Array.isArray(hold)) return hold.some((one) => matches(one, table, calls, row));
    return !!hold && hold.table === table && calls.includes(hold.method)
      && (hold.familyId === undefined || (row as { family_id?: string } | undefined)?.family_id === hold.familyId);
  };
  const settle = (table: string, calls: string[], send: () => PromiseLike<unknown>, row?: unknown): Promise<unknown> => {
    const verb = calls.find((c) => WRITES.includes(c)) ?? 'select';
    const nthWrite = verb === 'select' ? 0 : ++writes;
    const go = async () => {
      if (matches(opts.fail, table, calls, row)) return TRANSPORT_ERROR;
      const out = await send();
      events.push(`${actor}:${table}.${verb}`);
      return matches(opts.lose, table, calls, row) ? TRANSPORT_ERROR : out;
    };
    if (!held && (matches(opts.pause, table, calls, row) || (opts.pauseWrite !== undefined && nthWrite === opts.pauseWrite))) {
      held = true;
      arrive();
      return gate.then(go);
    }
    return go();
  };
  type Settle = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise<unknown>;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        const calls: string[] = [];
        let row: unknown;
        const wrapped: object = new Proxy(builder, {
          get(b, key) {
            if (key === 'then') return ((resolve, reject) => settle(table, calls, () => b as PromiseLike<unknown>, row).then(resolve, reject)) as Settle;
            const value = Reflect.get(b, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              calls.push(String(key));
              if (key === 'upsert' || key === 'insert') row = args[0];
              // `.maybeSingle()` runs its query when it is called, so it is
              // held back here rather than at its `then`.
              if (key === 'single' || key === 'maybeSingle') {
                return { then: ((resolve, reject) => settle(table, calls, () => Reflect.apply(value, b, args) as PromiseLike<unknown>, row).then(resolve, reject)) as Settle };
              }
              const out = Reflect.apply(value, b, args);
              return out === b ? wrapped : out;
            };
          },
        });
        return wrapped;
      };
    },
  }) as unknown as DB;
  return { client, reached, release };
}

/** The member's leave or switch-off goes to the database as `leave`. */
function leaveThrough(pause?: Hold, pauseWrite?: number) {
  const user = wire('leave', { pause, pauseWrite });
  wires.user = user.client;
  wires.service = wire('leave').client;
  return user;
}

async function until(seen: () => boolean, what: string, tries = 400) {
  for (let i = 0; i < tries && !seen(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(seen(), what).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetHookSlots(h.hooks);
  db = fresh();
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: LEAVER, userId: `${LEAVER}-parent`, role: 'parent' });
  events = [];
  seedNetwork(db);
  leaveThrough();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a leave that lands while a run is building is in neither the publication nor storage', () => {
  it('during buildContributionsBatch, after the run read consent', async () => {
    const without = await publicationWith(null);
    const run = wire('run', { pause: { table: 'meal_plans', method: 'select' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    await click(byName(screen(), JOIN));
    expect(consentOf(LEAVER)).toMatchObject({ enabled: false });
    expect(stored(LEAVER)).toEqual([]);
    expect(h.toasts.success).toEqual([LEFT]);

    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 144 });
    // The upsert wrote the row back after the leave's delete; the re-check took it away.
    expect(at(events, 'run:network_contributions.upsert')).toBeGreaterThan(at(events, 'leave:network_contributions.delete'));
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
    // The healthy families are all stored and published.
    expect(db.table('network_contributions')).toHaveLength(144);
    expect(published().size).toBeGreaterThanOrEqual(6);
  });

  it('between the consent read and the leaver\'s own network_contributions upsert', async () => {
    const without = await publicationWith(null);
    const run = wire('run', { pause: { table: 'network_contributions', method: 'upsert' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached; // the first upsert is the leaver's: contributing is in family_id order

    await click(byName(screen(), JOIN));
    expect(stored(LEAVER)).toEqual([]);

    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });

  it('between the upserts and the run\'s claim of the publication', async () => {
    const without = await publicationWith(null);
    const run = wire('run', { pause: { table: 'app_settings', method: 'select' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;
    expect(stored(LEAVER)).toHaveLength(1);

    await click(byName(screen(), JOIN));
    expect(h.toasts.success).toEqual([LEFT]);

    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });

  it('a scope switched off mid-run takes that scope\'s metrics out the same way', async () => {
    db = fresh(); h.db = db; seedNetwork(db, { timing: true, benchmarks: true }); leaveThrough();
    const without = await publicationWith({ timing: true, benchmarks: false });
    const run = wire('run', { pause: { table: 'meal_plans', method: 'select' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    await click(byName(screen(), BENCHMARKS));
    expect(consentOf(LEAVER)).toMatchObject({ enabled: true, scopes: { timing: true, benchmarks: false } });
    expect(h.toasts.success).toEqual(['Preferences saved']);

    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });
});

describe('a leave that meets the run inside its claim waits, so the publication comes first', () => {
  it('between the re-check and the network_aggregates upsert: the leave is written after the publish, and said once it is', async () => {
    const withLeaver = await publicationWith({ benchmarks: true });
    const run = wire('run', { pause: { table: 'network_aggregates', method: 'upsert' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached; // holding the claim, consent re-read with the leaver still in

    const leaving = click(byName(screen(), JOIN));
    await until(() => events.includes('leave:app_settings.select'), 'the leave asked for the claim');
    expect(events).not.toContain('leave:network_consent.upsert');
    expect(h.toasts.success).toEqual([]);

    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 145 });
    await leaving;
    // Published before the consent was written, and before the family was told.
    expect(at(events, 'run:network_aggregates.upsert')).toBeLessThan(at(events, 'leave:network_consent.upsert'));
    expect(h.toasts.success).toEqual([LEFT]);
    expect(stored(LEAVER)).toEqual([]);
    // That snapshot predates the leave and stands for its epoch, as designed …
    expect(published()).toEqual(withLeaver);
    // … and nothing after the leave publishes anything new inside it.
    expect(await runNetworkAggregation(db as unknown as DB, NEXT_NIGHT)).toMatchObject({ ok: true, held: true, contributors: 144 });
    expect(published()).toEqual(withLeaver);
    expect(stored(LEAVER)).toEqual([]);
  });

  it('a run that reaches its claim while a leave holds it waits for the leave, then publishes without it', async () => {
    const without = await publicationWith(null);
    const run = wire('run', { pause: { table: 'meal_plans', method: 'select' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    const leave = leaveThrough({ table: 'network_contributions', method: 'delete' });
    const leaving = click(byName(screen(), JOIN));
    await leave.reached; // consent written, the claim held, the delete not yet sent
    run.release();
    await until(() => events.includes('run:app_settings.select'), 'the run asked for the claim');
    leave.release();
    await leaving;

    const result = await running;
    expect(result).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(result.deferred).toBeUndefined();
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });
});

describe('a run that finds the publication taken still forgets a family that left meanwhile', () => {
  it('its upsert after the leave\'s delete is followed by a re-check that deletes it', async () => {
    const without = await publicationWith(null);
    const late = wire('late', { pause: { table: 'meal_plans', method: 'select' } });
    const lateRun = runNetworkAggregation(late.client, NOW);
    await late.reached; // read consent with the leaver in

    await click(byName(screen(), JOIN));
    expect(stored(LEAVER)).toEqual([]);

    const holder = wire('run', { pause: { table: 'network_aggregates', method: 'update' } });
    const holding = runNetworkAggregation(holder.client, NOW);
    await holder.reached; // holds the claim

    late.release();
    expect(await lateRun).toMatchObject({ ok: true, deferred: true, contributors: 144 });
    expect(at(events, 'late:network_contributions.upsert')).toBeGreaterThan(at(events, 'leave:network_contributions.delete'));
    expect(stored(LEAVER)).toEqual([]);

    holder.release();
    expect(await holding).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(published()).toEqual(without);
    expect(stored(LEAVER)).toEqual([]);
  });
});

// N8-withdrawal-during-run/failed-upsert-skips-recheck (round 4, re-fix 1). A
// run in which ANY family's upsert failed returned 'failed to persist family
// contributions' straight after the upserts, before the claim and the
// re-check. So a leaver's row it wrote back after a confirmed, fenced leave
// stayed stored until the next good run's prune, after the toast had said it
// was deleted. Nothing was published, but the storage promise did not hold.
describe('a run that fails to store another family still forgets a family that left meanwhile', () => {
  const PERSIST_FAILED = 'failed to persist family contributions';
  const OTHER = 'f-20';

  it('a leave during buildContributionsBatch, then another family\'s upsert fails: the leaver has no stored row', async () => {
    const without = await publicationWith(null);
    const run = wire('run', {
      pause: { table: 'meal_plans', method: 'select' },
      fail: { table: 'network_contributions', method: 'upsert', familyId: OTHER },
    });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    await click(byName(screen(), JOIN));
    expect(consentOf(LEAVER)).toMatchObject({ enabled: false });
    expect(stored(LEAVER)).toEqual([]);
    expect(h.toasts.success).toEqual([LEFT]);

    run.release();
    expect(await running).toMatchObject({ ok: false, error: PERSIST_FAILED, contributors: 143, aggregates: 0 });
    // The upsert wrote the row back after the leave's delete; the failing run's re-check took it away.
    expect(at(events, 'run:network_contributions.upsert')).toBeGreaterThan(at(events, 'leave:network_contributions.delete'));
    expect(stored(LEAVER)).toEqual([]);
    // Every family that still consents keeps the row the run wrote, and nothing is published.
    expect(db.table('network_contributions')).toHaveLength(143);
    expect(stored(OTHER)).toEqual([]);
    expect(db.table('network_aggregates')).toEqual([]);
    // The next good run stores the family that failed and publishes without the leaver.
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });

  it('a scope switched off during the build, then another family\'s upsert fails: the switched-off metrics are not stored again', async () => {
    db = fresh(); h.db = db; seedNetwork(db, { timing: true, benchmarks: true }); leaveThrough();
    const run = wire('run', {
      pause: { table: 'meal_plans', method: 'select' },
      fail: { table: 'network_contributions', method: 'upsert', familyId: OTHER },
    });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    await click(byName(screen(), BENCHMARKS));
    expect(consentOf(LEAVER)).toMatchObject({ enabled: true, scopes: { timing: true, benchmarks: false } });
    expect(h.toasts.success).toEqual(['Preferences saved']);

    run.release();
    expect(await running).toMatchObject({ ok: false, error: PERSIST_FAILED, aggregates: 0 });
    expect(at(events, 'run:network_contributions.upsert')).toBeGreaterThan(at(events, 'leave:network_contributions.delete'));
    expect(stored(LEAVER)).toEqual([]);
    expect(db.table('network_contributions')).toHaveLength(143);
  });

  it('the leaver\'s own upsert that lands but whose answer is lost is taken back too', async () => {
    const run = wire('run', {
      pause: { table: 'meal_plans', method: 'select' },
      lose: { table: 'network_contributions', method: 'upsert', familyId: LEAVER },
    });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;

    await click(byName(screen(), JOIN));
    expect(stored(LEAVER)).toEqual([]);

    run.release();
    expect(await running).toMatchObject({ ok: false, error: PERSIST_FAILED, contributors: 144, aggregates: 0 });
    // It landed (the run counted it a failure), after the leave's delete …
    expect(at(events, 'run:network_contributions.upsert')).toBeGreaterThan(at(events, 'leave:network_contributions.delete'));
    // … and the re-check took it back with the rows the run knows it wrote.
    expect(stored(LEAVER)).toEqual([]);
    expect(db.table('network_contributions')).toHaveLength(144);
  });

  it('a re-check on that path that cannot read consent takes back every row the run wrote; the next run rebuilds them', async () => {
    const withLeaver = await publicationWith({ benchmarks: true });
    const run = wire('run', {
      fail: [
        { table: 'network_contributions', method: 'upsert', familyId: OTHER },
        { table: 'network_consent', method: 'in' },
      ],
    });
    expect(await runNetworkAggregation(run.client, NOW)).toMatchObject({ ok: false, error: PERSIST_FAILED, contributors: 0, aggregates: 0 });
    expect(db.table('network_contributions')).toEqual([]);
    expect(db.table('network_aggregates')).toEqual([]);
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, held: false, contributors: 145 });
    expect(db.table('network_contributions')).toHaveLength(145);
    expect(published()).toEqual(withLeaver);
  });
});

describe('a claim held past the wait does not hold the leave back', () => {
  it('writes the withdrawal anyway after a bounded wait, and says what is not yet proven', async () => {
    // A run that died holding the claim keeps it until its ten-minute ttl.
    db.seed('app_settings', [{ key: NETWORK_PUBLICATION_LEASE_KEY, value: { token: 'crashed-run' }, updated_at: NOW.toISOString() }]);

    await click(byName(screen(), JOIN));
    expect(events.filter((e) => e === 'leave:app_settings.select')).toHaveLength(WITHDRAWAL_CLAIM_ATTEMPTS);
    expect(consentOf(LEAVER)).toMatchObject({ enabled: false, consented_by: null });
    expect(stored(LEAVER)).toEqual([]);
    expect(h.toasts.success).toEqual([LEFT_WHILE_PUBLISHING]);
    expect(h.toasts.success[0]).not.toMatch(/nothing is shared/i);
    // The dead holder's claim is left to its ttl, not taken or released by the leave.
    expect(db.table('app_settings')).toEqual([expect.objectContaining({ value: { token: 'crashed-run' }, updated_at: NOW.toISOString() })]);
  });
});

describe('a re-check that cannot read consent vouches for nothing', () => {
  it('takes back every row the run wrote and publishes nothing; the next run rebuilds them', async () => {
    const withLeaver = await publicationWith({ benchmarks: true });
    const run = wire('run', { fail: { table: 'network_consent', method: 'in' } });
    expect(await runNetworkAggregation(run.client, NOW)).toMatchObject({ ok: false, error: 'failed to re-check consent', aggregates: 0 });
    expect(db.table('network_contributions')).toEqual([]);
    expect(db.table('network_aggregates')).toEqual([]);
    // The claim was given back: the next run publishes at once.
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, held: false, contributors: 145 });
    expect(published()).toEqual(withLeaver);
    expect(db.table('network_contributions')).toHaveLength(145);
  });
});

describe('only a manager withdraws, as only a manager may consent (0353)', () => {
  const NOT_SAVED = "That change wasn't saved — you may not have permission. Refresh and try again.";
  /** The household and member the module shows, which the action is called with. */
  const ON_SCREEN = () => ({ expectedFamilyId: h.app.familyId, expectedUserId: h.app.userId });
  it('a teen calling the action directly changes nothing and takes no claim', async () => {
    Object.assign(h.app, { role: 'teen' });
    expect(await withdrawFromNetworkAction({ leave: true }, ON_SCREEN())).toEqual({ ok: false, error: NOT_SAVED });
    expect(consentOf(LEAVER)).toMatchObject({ enabled: true, scopes: { benchmarks: true } });
    expect(events).toEqual([]);
  });

  it('a change that is not a leave or a scope map is refused before anything is written', async () => {
    expect(await withdrawFromNetworkAction({ scopes: { benchmarks: 'off' } }, ON_SCREEN())).toMatchObject({ ok: false, error: NOT_SAVED });
    expect(await withdrawFromNetworkAction(null as never, ON_SCREEN())).toMatchObject({ ok: false, error: NOT_SAVED });
    expect(consentOf(LEAVER)).toMatchObject({ enabled: true, scopes: { benchmarks: true } });
    expect(events).toEqual([]);
  });
});

// N8-withdrawal-during-run/order-invariant-unpinned (round 5). The storage
// guarantee for a run that does not hold the claim, and for a leave written
// without it, rests on one order in withdrawal-server.ts: consent first, then
// the delete. With the delete first, a deferred run's upsert landing between
// the two is followed by a re-check that still reads the family as consenting,
// and the row the family was told is deleted stays stored. No case paused the
// leave between its two writes, so swapping them left every test green; nor
// did any case close an account mid-run, so dropping the re-check's
// closed-account filter did too.
describe('a leave writes consent before it deletes, which the re-check of a run without the claim relies on', () => {
  it('held between its two writes while a run that defers upserts and re-checks, the leave leaves no row stored', async () => {
    // A run that read consent with the leaver in, paused before its upserts …
    const late = wire('late', { pause: { table: 'meal_plans', method: 'select' } });
    const lateRun = runNetworkAggregation(late.client, NOW);
    await late.reached;
    // … and another run holding the publication claim, paused at its hold.
    const holder = wire('run', { pause: { table: 'network_aggregates', method: 'update' } });
    const holding = runNetworkAggregation(holder.client, NOW);
    await holder.reached;

    // The leave cannot have the claim, so after its wait it writes without it.
    // It is held back at its SECOND write, whichever of the two that is.
    const leaveWrites = () => events.filter((e) => e === 'leave:network_consent.upsert' || e === 'leave:network_contributions.delete');
    const leave = leaveThrough(undefined, 2);
    const leaving = click(byName(screen(), JOIN));
    await leave.reached;
    expect(leaveWrites()).toHaveLength(1);

    late.release();
    expect(await lateRun).toMatchObject({ ok: true, deferred: true, contributors: 144 });
    // Its upsert of the leaver landed between the leave's two writes, and the
    // re-check after it took the row back.
    expect(at(events, 'late:network_contributions.upsert')).toBeGreaterThan(at(events, leaveWrites()[0]));
    expect(stored(LEAVER)).toEqual([]);

    leave.release();
    await leaving;
    expect(h.toasts.success).toEqual([LEFT_WHILE_PUBLISHING]);
    expect(stored(LEAVER)).toEqual([]);
    // The order the above rests on.
    expect(leaveWrites()).toEqual(['leave:network_consent.upsert', 'leave:network_contributions.delete']);

    holder.release();
    expect(await holding).toMatchObject({ ok: true, held: false });
    expect(stored(LEAVER)).toEqual([]);
  });

  it('a family whose account closes while the run builds is taken back by the re-check, as a leave is', async () => {
    const without = await publicationWith(null);
    const run = wire('run', { pause: { table: 'meal_plans', method: 'select' } });
    const running = runNetworkAggregation(run.client, NOW);
    await run.reached;
    // Its consent stays switched on; the account is closed (families.closed_at).
    Object.assign(db.table('families').find((f) => f.id === LEAVER)!, { closed_at: NOW.toISOString() });
    run.release();
    expect(await running).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(consentOf(LEAVER)).toMatchObject({ enabled: true });
    expect(stored(LEAVER)).toEqual([]);
    expect(published()).toEqual(without);
  });
});

// N8-withdrawal-during-run/leave-held-claim-defers-silently (round 5). A leave
// takes the claim a run publishes under. A run that found it held for six
// tries returned { ok: true, deferred: true } — but only a run publishes, so
// deferring to a LEAVE left the night with nobody holding, re-stamping or
// publishing the figures (on an epoch's first night, nothing published at
// all) while the cron reported success. A leave whose function died after
// claiming, or a manager calling the action in a loop around 03:00, was
// enough. The claim now records who holds it: a run waits out a withdrawal
// and never defers to one, a withdrawal still holding it after that wait
// fails the night (so does a holder that recorded no kind; only a run is
// deferred to), and a member's claims are rate-limited (their withdrawals
// never are).
describe('a run never defers to a withdrawal', () => {
  const runTries = () => events.filter((e) => e === 'run:app_settings.select').length;

  it('waits out a leave holding the claim past the tries it gives another run, then publishes without it', async () => {
    const without = await publicationWith(null);
    const leave = leaveThrough({ table: 'network_contributions', method: 'delete' });
    const leaving = click(byName(screen(), JOIN));
    await leave.reached; // consent written, the claim held, the delete not yet sent

    const running = runNetworkAggregation(wire('run').client, NOW);
    await until(() => runTries() > RUN_CLAIM_ATTEMPTS, 'the run kept asking past the tries it gives a run', 1600);
    leave.release();
    await leaving;
    expect(h.toasts.success).toEqual([LEFT]);

    const result = await running;
    expect(result).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(result.deferred).toBeUndefined();
    expect(published()).toEqual(without);
    expect(stored(LEAVER)).toEqual([]);
  });

  it('fails the night, rather than report it done, when a withdrawal still holds the claim after that wait', async () => {
    const leave = leaveThrough({ table: 'network_contributions', method: 'delete' });
    const leaving = click(byName(screen(), JOIN));
    await leave.reached; // a leave whose function never gets past here

    const result = await runNetworkAggregation(wire('run').client, NOW);
    expect(result).toMatchObject({ ok: false, error: 'the publication claim is held, and not by a run', contributors: 144, aggregates: 0 });
    expect(result.deferred).toBeUndefined();
    expect(runTries()).toBe(RUN_WAITS_FOR_A_WITHDRAWAL_ATTEMPTS);
    expect(db.table('network_aggregates')).toEqual([]);
    // What it stored for the families still in stays for the next night.
    expect(db.table('network_contributions')).toHaveLength(144);

    leave.release();
    await leaving;
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, held: false, contributors: 144 });
    expect(published().size).toBeGreaterThanOrEqual(6);
  });

  it('nor to a holder that recorded no kind, while it still defers to one recorded as a run', async () => {
    const heldBy = (value: Record<string, string>) => db.replace('app_settings', [
      { key: NETWORK_PUBLICATION_LEASE_KEY, value, updated_at: NOW.toISOString() },
    ]);
    // A claim from before holders were recorded: not known to publish.
    heldBy({ token: 'from-an-earlier-deploy' });
    const unknown = await runNetworkAggregation(wire('run').client, NOW);
    expect(unknown).toMatchObject({ ok: false, error: 'the publication claim is held, and not by a run', contributors: 145, aggregates: 0 });
    expect(unknown.deferred).toBeUndefined();
    expect(runTries()).toBe(RUN_CLAIM_ATTEMPTS);
    expect(db.table('network_aggregates')).toEqual([]);

    // Control: another run holds it, which publishes, so this one defers.
    events = [];
    heldBy({ token: 'another-run', holder: 'run' });
    expect(await runNetworkAggregation(wire('run').client, NOW))
      .toMatchObject({ ok: true, deferred: true, contributors: 145, aggregates: 0 });
    expect(runTries()).toBe(RUN_CLAIM_ATTEMPTS);
  });

  it('a race lost for the claim after a long wait reads who won it before it answers', async () => {
    const lease = () => db.table('app_settings').find((r) => r.key === NETWORK_PUBLICATION_LEASE_KEY)!;
    db.replace('app_settings', [{ key: NETWORK_PUBLICATION_LEASE_KEY, value: { token: 'a-leave', holder: 'withdrawal' }, updated_at: NOW.toISOString() }]);
    // The run's first attempt to TAKE the claim is held back …
    const run = wire('run', { pause: { table: 'app_settings', method: 'update' } });
    const running = runNetworkAggregation(run.client, NOW);
    await until(() => runTries() > RUN_CLAIM_ATTEMPTS + 2, 'the run waited behind the leave past a run\'s tries', 1600);
    // … the leave gives it back, the run goes to take it …
    Object.assign(lease(), { updated_at: '1970-01-01T00:00:00.000Z' });
    await run.reached;
    // … and another run takes it first.
    Object.assign(lease(), { value: { token: 'another-run', holder: 'run' }, updated_at: NOW.toISOString() });
    run.release();
    // Lost on a try past a run's six, it reads the winner, a run, and defers.
    expect(await running).toMatchObject({ ok: true, deferred: true, contributors: 145 });
  });

  it('a member past their claim limit still leaves, only without the claim', async () => {
    db = fresh({ rate_limit_hit: rateLimitHit }); h.db = db; seedNetwork(db); leaveThrough();
    const ON_SCREEN = { expectedFamilyId: LEAVER, expectedUserId: `${LEAVER}-parent` };
    const claimStatements = () => events.filter((e) => e.startsWith('leave:app_settings.')).length;
    for (let i = 0; i < WITHDRAWAL_CLAIMS_PER_WINDOW; i++) {
      expect(await withdrawFromNetworkAction({ leave: true }, ON_SCREEN), `leave ${i + 1}`).toMatchObject({ ok: true, fenced: true });
    }
    const claimed = claimStatements();
    expect(claimed).toBeGreaterThan(0);

    // One more inside the window: written all the same, with no claim taken.
    expect(await withdrawFromNetworkAction({ leave: true }, ON_SCREEN)).toMatchObject({ ok: true, fenced: false });
    expect(claimStatements()).toBe(claimed);
    expect(consentOf(LEAVER)).toMatchObject({ enabled: false, consented_by: null });
    expect(stored(LEAVER)).toEqual([]);
    // And a run meanwhile is not held up by it.
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, held: false, contributors: 144 });
  });
});
