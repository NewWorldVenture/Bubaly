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
}));

// `getFeatureTiersByHref` is request-`cache`d, and React's `cache` is not
// available outside a render. Unwrapping it keeps the REAL tier resolution
// (catalog defaults merged with admin overrides) under test.
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), cache: <T>(fn: T) => fn }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => state.db,
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: { familyId: state.activeFamilyId, role: 'parent', member: { id: 'member-1' } },
  }),
}));

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
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
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'single']) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: new Error('subscriptions read failed') }).then(resolve);
    return chain;
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) =>
        state.failSubscriptionsRead && table === 'subscriptions'
          ? failing()
          : (target as DB).from(table as never);
    },
  }) as DB;
}

beforeEach(() => {
  scan.run.mockClear();
  state.failSubscriptionsRead = false;
  state.activeFamilyId = PLUS;
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const db = createInMemorySupabase<DB>();
  // A past trial on both, so the only thing separating them is what they pay
  // for. (An active trial grants Basic, which is still short of Plus, but
  // leaving it out keeps the assertion about one variable.)
  db.seed('families', [
    { id: FREE, name: 'Free household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: PLUS, name: 'Plus household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
  ]);
  db.seed('subscriptions', [{ family_id: PLUS, plan: 'plus', status: 'active' }]);
  state.db = withFailingSubscriptions(db);
});

const cronRequest = (secret = 'cron-secret') =>
  new Request('http://localhost/api/cron/autopilot-scan', { headers: { authorization: `Bearer ${secret}` } });

const scannedFamilies = () => scan.run.mock.calls.map((call) => (call as unknown[])[1]);

describe('the Autopilot cron runs only for entitled families', () => {
  it('scans a Family+ household and skips a Free one', async () => {
    const response = await cron(cronRequest() as never);
    const body = await response.json();

    expect(scannedFamilies()).toEqual([PLUS]);
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
