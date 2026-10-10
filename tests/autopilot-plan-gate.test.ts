import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Family Autopilot is a Plus feature, and it was Plus on the SCREEN only.
 *
 * Traced on 2026-09-13. `/dashboard/autopilot` is `requireFeature`-gated and
 * `resolveAutopilotSuggestionAction` re-checks the tier before it writes — but
 * the two things that actually RUN Autopilot did not check at all:
 *
 *   GET  /api/cron/autopilot-scan   looped `families` with `.limit(5000)`
 *   POST /api/autopilot/scan        required only a session
 *
 * So every family on the platform got the Plus feature nightly: behavioural
 * traits written to `family_digital_twin_profiles`, `reminders` and
 * `grocery_items` auto-created, push/email sent. They could not open the page
 * to see where any of it came from, and the resolve action refused them, so
 * they could not dismiss it either.
 *
 * This is the same shape as the family @bubaly.com address (see
 * `FAMILY_EMAIL_MIN_PLAN_LEVEL`): a gate stated on a screen and absent from the
 * pipeline behind it. The fix is the same too — one resolver, used by both.
 */

type DB = SupabaseClient<Database>;
type Row = Record<string, unknown>;

const FREE = 'family-free';
const PLUS = 'family-plus';

const state = vi.hoisted(() => ({
  db: null as unknown,
  activeFamilyId: 'family-plus',
  failSubscriptionsRead: false,
  failTierRead: false,
  superAdmin: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => state.db,
}));

vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => state.superAdmin,
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: {
      familyId: state.activeFamilyId, role: 'parent', member: { id: 'member-1' },
      // `ctx.active.family` is the whole `families` row, and the scan now takes
      // that family's `timezone` so its "today" is the family's rather than the
      // server's. A zone that is NOT UTC, so a route that quietly fell back to
      // Greenwich would be visible in the assertion below.
      family: { id: state.activeFamilyId, timezone: 'America/Los_Angeles' },
    },
  }),
}));

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key),
    // The on-demand scan words the suggestions it stores for the member who
    // pressed Rescan, so the route reads the request's locale too.
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});

// The scan itself is covered by tests/autopilot-persistence-boundaries.test.ts.
// What is under test here is WHO it runs for, so it is replaced by a spy and
// the assertions read the family ids it was handed.
const scan = vi.hoisted(() => ({
  run: vi.fn(async () => ({ scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 })),
}));
vi.mock('@/lib/autopilot/scan', () => ({ runAutopilotScan: scan.run }));

const { GET: cron } = await import('@/app/api/cron/autopilot-scan/route');
const { POST: onDemand } = await import('@/app/api/autopilot/scan/route');

/**
 * Wraps the in-memory client so one table's read can be made to fail. A plan
 * that cannot be read is the case these tests care most about, and it cannot be
 * expressed by seeding.
 */
function withFailingSubscriptions(db: ReturnType<typeof createInMemorySupabase<DB>>): DB {
  const failing = () => {
    const chain: Row = {};
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'abortSignal', 'maybeSingle', 'single']) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: new Error('read failed') }).then(resolve);
    return chain;
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) =>
        (state.failSubscriptionsRead && table === 'subscriptions') || (state.failTierRead && table === 'app_settings')
          ? failing()
          : (target as DB).from(table as never);
    },
  }) as DB;
}

beforeEach(() => {
  scan.run.mockClear();
  state.failSubscriptionsRead = false;
  state.failTierRead = false;
  state.superAdmin = false;
  state.activeFamilyId = PLUS;
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const db = createInMemorySupabase<DB>();
  // A past trial on both, so the only thing separating them is what they pay
  // for. (An active trial grants Basic, which is still short of Plus, but
  // leaving it out keeps the assertion about one variable.)
  db.seed('families', [
    { id: FREE, name: 'Free household', timezone: 'Europe/Berlin', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: PLUS, name: 'Plus household', timezone: 'Asia/Tokyo', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
  ]);
  db.seed('subscriptions', [{ family_id: PLUS, plan: 'plus', status: 'active' }]);
  state.db = withFailingSubscriptions(db);
});

const cronRequest = (secret = 'cron-secret') =>
  new Request('http://localhost/api/cron/autopilot-scan', { headers: { authorization: `Bearer ${secret}` } });

const scannedFamilies = () => scan.run.mock.calls.map((call) => (call as unknown[])[1]);
/** The zone each scan was handed — it decides whose day the scan answers. */
const scannedZones = () => scan.run.mock.calls.map((call) => (call as unknown[])[3]);

describe('the Autopilot cron runs only for entitled families', () => {
  it('scans a Family+ household and skips a Free one', async () => {
    const response = await cron(cronRequest() as never);
    const body = await response.json();

    expect(scannedFamilies()).toEqual([PLUS]);
    // One cron pass over every family is not a reason to scan them all in
    // Greenwich: each family is scanned in ITS OWN zone, off the row this loop
    // is already holding.
    expect(scannedZones()).toEqual(['Asia/Tokyo']);
    expect(body).toMatchObject({ ok: true, families: 2, entitled: 1, skipped: 1, failures: 0 });
  });

  it('counts an unreadable plan as a failure, never as a skip', async () => {
    // The distinction that matters. Treating "we could not read the plan" as
    // "not entitled" would silently stop Autopilot for a paying family the
    // moment a subscription read blipped, and the cron would report success.
    state.failSubscriptionsRead = true;

    const response = await cron(cronRequest() as never);
    const body = await response.json();

    expect(scan.run).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: false, skipped: 0, failures: 2 });
    expect(response.status).toBe(502);
  });

  it('runs for nobody when the feature tiers cannot be read', async () => {
    // The catalog default is not the configured tier: an admin can make
    // Autopilot stricter (Off, say) than its default, and a pass that fell
    // back to the default would run it for families the admin excluded.
    state.failTierRead = true;

    const response = await cron(cronRequest() as never);

    expect(scan.run).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('stops starting families inside its time budget, names the ones it did not reach, and rotates who goes first', async () => {
    const db = createInMemorySupabase<DB>();
    const ids = Array.from({ length: 12 }, (_, i) => `family-${String(i).padStart(2, '0')}`);
    db.seed('families', ids.map((id) => ({ id, name: id, timezone: 'UTC', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null })));
    db.seed('subscriptions', ids.map((id) => ({ family_id: id, plan: 'plus', status: 'active' })));
    state.db = db;
    let clock = Date.parse('2026-09-21T06:30:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Every scan takes 20 seconds of the function's 60.
    scan.run.mockImplementation(async () => { clock += 20_000; return { scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 }; });

    const response = await cron(cronRequest() as never);
    const body = await response.json();
    const first = scannedFamilies();

    expect(first.length).toBeLessThan(ids.length);
    expect(body.unreached).toBe(ids.length - first.length);
    expect([...first, ...body.unreachedFamilies].sort()).toEqual(ids);
    expect(body.ok).toBe(false);
    expect(response.status).toBe(502);

    // The next day starts somewhere else, so the same families are not always last.
    scan.run.mockClear();
    clock = Date.parse('2026-09-22T06:30:00Z');
    await cron(cronRequest() as never);
    expect(scannedFamilies()[0]).not.toBe(first[0]);
    scan.run.mockImplementation(async () => ({ scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 }));
    vi.mocked(Date.now).mockRestore();
  });

  it('reaches every family within a bounded number of runs, not one family further a day', async () => {
    // 400 families, about 40 scanned a run. A start that moved one family a day
    // left the family after the cut-off waiting ~360 days; spread starts reach
    // every family within 4·N/C runs (lib/autopilot/cron-rotation.ts).
    const db = createInMemorySupabase<DB>();
    const ids = Array.from({ length: 400 }, (_, i) => `family-${String(i).padStart(3, '0')}`);
    db.seed('families', ids.map((id) => ({ id, name: id, timezone: 'UTC', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null })));
    db.seed('subscriptions', ids.map((id) => ({ family_id: id, plan: 'plus', status: 'active' })));
    state.db = db;
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    scan.run.mockImplementation(async () => { clock += 4_000; return { scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 }; });

    const reached = new Set<unknown>();
    let perRun = Infinity;
    let runs = 0;
    const firstDay = Date.parse('2026-09-21T06:30:00Z');
    while (reached.size < ids.length && runs < ids.length) {
      scan.run.mockClear();
      clock = firstDay + runs * 86_400_000;
      await cron(cronRequest() as never);
      const scannedNow = scannedFamilies();
      perRun = Math.min(perRun, scannedNow.length);
      for (const id of scannedNow) reached.add(id);
      runs++;
    }

    expect(perRun).toBeGreaterThan(10);
    expect(perRun).toBeLessThan(ids.length);
    expect(reached.size).toBe(ids.length);
    expect(runs).toBeLessThanOrEqual(Math.ceil((4 * ids.length) / perRun));
    scan.run.mockImplementation(async () => ({ scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 }));
    vi.mocked(Date.now).mockRestore();
  }, 60_000);

  it('stops waiting for a family whose scan hangs, so the pass still returns inside maxDuration', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release: () => void = () => {};
      scan.run.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 });
      }));
      const pending = cron(cronRequest() as never);
      await vi.advanceTimersByTimeAsync(12_000);
      const response = await pending;
      const body = await response.json();
      expect(scannedFamilies()).toEqual([PLUS]);
      expect(body).toMatchObject({ ok: false, failures: 1, scanned: 0 });
      // A late finish is not counted a second time.
      release();
      await Promise.resolve();
      expect(body.scanned).toBe(0);
    } finally {
      vi.useRealTimers();
      scan.run.mockImplementation(async () => ({ scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 }));
    }
  });

  it('still refuses an unauthorised caller before reading anything', async () => {
    const response = await cron(cronRequest('wrong') as never);

    expect(response.status).toBe(401);
    expect(scan.run).not.toHaveBeenCalled();
  });
});

describe('the on-demand Autopilot scan runs only for entitled families', () => {
  it('refuses a Free family with 403 and runs nothing', async () => {
    state.activeFamilyId = FREE;

    const response = await onDemand();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ needLevel: 2 });
    expect(scan.run).not.toHaveBeenCalled();
  });

  it('runs for a Family+ household', async () => {
    state.activeFamilyId = PLUS;

    const response = await onDemand();

    expect(response.status).toBe(200);
    expect(scannedFamilies()).toEqual([PLUS]);
    expect(scannedZones()).toEqual(['America/Los_Angeles']);
  });

  it('lets a super administrator preview it past their plan, as the page does (C1-S9-98)', async () => {
    // requireFeature lets a super admin onto /dashboard/autopilot whatever
    // their family pays for. The scan behind it refused them, and the screen
    // then showed "100% the day runs smoothly" over a scan that never ran.
    state.activeFamilyId = FREE;
    state.superAdmin = true;

    const response = await onDemand();

    expect(response.status).toBe(200);
    expect(scannedFamilies()).toEqual([FREE]);
  });

  it('keeps the nightly cron on each family\'s real plan — no preview there', async () => {
    state.superAdmin = true;
    await cron(cronRequest() as never);
    expect(scannedFamilies()).toEqual([PLUS]);
    expect(fs.readFileSync(path.join(process.cwd(), 'app/api/cron/autopilot-scan/route.ts'), 'utf8')).not.toContain('isSuperAdmin');
  });

  it('answers 503 — not 403 — when the plan cannot be read', async () => {
    // 403 would tell a paying family they are not entitled because of a
    // database blip, and the client would offer them an upgrade they already
    // bought. 503 says "ask again", which is the truth.
    state.activeFamilyId = PLUS;
    state.failSubscriptionsRead = true;

    const response = await onDemand();

    expect(response.status).toBe(503);
    expect(scan.run).not.toHaveBeenCalled();
  });
});

describe('the screen and the pipeline resolve entitlement through one function', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('has requireFeature delegate rather than re-implement the comparison', () => {
    // The page guard and the two routes above drifted precisely because each
    // held its own copy of "tier → level → compare". requireFeature now calls
    // the same resolver, so there is one copy left to change.
    const source = read('lib/supabase/auth.ts');
    expect(source).toContain('resolveFeatureEntitlement');
    expect(source).not.toContain('tierToLevel');
  });
});
