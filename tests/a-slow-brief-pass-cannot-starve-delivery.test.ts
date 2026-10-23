// A slow morning-brief pass cannot starve the day's delivery.
//
// /api/cron/notifications budgets its generation pass so push dispatch and the
// email digests always run inside maxDuration (tests/a-slow-generation-pass-
// cannot-starve-delivery.test.ts). Between the two sits the morning-brief pass
// (lib/briefing/deliver.ts deliverMorningBriefs), and it still awaited every
// open family in turn with no clock, no per-family limit and no concurrency:
// one family whose brief never answered held the run until the platform killed
// it — nothing pushed, nothing emailed, no response to count — and enough
// families at a few seconds each spent the slice kept for delivery.
//
// Behavioural, with the clock and timers faked: the real route and the real
// brief pass against the in-memory database; only the brief's final notify
// (the step that files and pushes) is slowed or held, and generation, push
// dispatch and the email digests are recorders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  briefed: [] as string[],
  hang: new Set<string>(),
  /** Each brief moves the clock this far: how a pass outgrows its slice. */
  briefTakesMs: 0,
  startedAt: 0,
  pushStartedAfterMs: [] as number[],
  emailDeliveries: 0,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/notifications', () => ({ generateFamilyNotifications: async () => 0 }));
vi.mock('@/lib/server/push', () => ({
  dispatchPendingPushes: async () => {
    h.pushStartedAfterMs.push(Date.now() - h.startedAt);
    return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
  },
}));
vi.mock('@/lib/server/notification-emails', () => ({
  deliverNotificationEmails: async () => { h.emailDeliveries += 1; return { sent: 0, failed: 0, skipped: 0 }; },
}));
// The sweeps are recorders; the brief's own reads (listPending) stay real.
vi.mock('@/lib/services/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/approvals')>()),
  expireStale: async () => ({ expired: 0, blockedRuns: 0, failures: 0 }),
  resumeSettledRuns: async () => ({ resumed: 0, failures: 0 }),
  remindPendingApprovals: async () => ({ reminded: 0, families: 0, failures: 0 }),
}));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: async (scope: { familyId: string }) => {
    if (h.hang.has(scope.familyId)) return new Promise(() => {});
    if (h.briefTakesMs) vi.setSystemTime(Date.now() + h.briefTakesMs);
    h.briefed.push(scope.familyId);
    return { ok: true, data: { created: 1 } };
  },
}));

const { GET: notifications } = await import('@/app/api/cron/notifications/route');
const { PUSH_DISPATCH_BUDGET_MS } = await vi.importActual<typeof import('@/lib/server/push')>('@/lib/server/push');
const { maxDuration } = await import('@/app/api/cron/notifications/route');

let db: InMemorySupabase;
const families = (n: number) => Array.from({ length: n }, (_, i) => `fam-${String(i).padStart(2, '0')}`);

/** Runs the route and lets `ms` of faked time pass; says whether it answered. */
async function within(ms: number): Promise<{ settled: boolean; response?: Response }> {
  let response: Response | undefined;
  h.startedAt = Date.now();
  const pending = notifications(new Request('https://bubaly.test/api/cron/notifications') as never).then((r) => { response = r; });
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.race([pending, Promise.resolve()]);
  return { settled: response !== undefined, response };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T11:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.briefed = []; h.hang = new Set(); h.briefTakesMs = 0; h.pushStartedAfterMs = []; h.emailDeliveries = 0;
  db = createInMemorySupabase();
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one family whose brief never answers', () => {
  it('costs its own timeout and its own failure; every other family is briefed, and pushes and emails still go out', async () => {
    db.seed('families', families(3).map((id) => ({ id, closed_at: null, timezone: 'UTC' })));
    h.hang.add('fam-01');

    const { settled, response } = await within(120_000);
    expect(settled, 'the run hung behind one family\'s brief and delivered nothing').toBe(true);
    expect([...h.briefed].sort()).toEqual(['fam-00', 'fam-02']);
    expect(h.pushStartedAfterMs).toHaveLength(1);
    expect(h.emailDeliveries).toBe(1);
    expect(response!.status).toBe(502);
    expect(await response!.json()).toMatchObject({ ok: false, briefs: { delivered: 2, families: 3, failed: 1 } });
  });
});

describe('a brief pass that outgrows its slice', () => {
  it('stops starting families, counts the rest as failed, and leaves push dispatch its budget inside maxDuration', async () => {
    db.seed('families', families(12).map((id) => ({ id, closed_at: null, timezone: 'UTC' })));
    h.briefTakesMs = 30_000; // twelve families in turn would take six minutes

    const { settled, response } = await within(1_000);
    expect(settled).toBe(true);
    expect(h.pushStartedAfterMs).toHaveLength(1);
    expect(
      h.pushStartedAfterMs[0],
      'push dispatch started too late to finish inside maxDuration',
    ).toBeLessThanOrEqual(maxDuration * 1_000 - PUSH_DISPATCH_BUDGET_MS);
    expect(h.emailDeliveries).toBe(1);

    const body = await response!.json();
    expect(response!.status, 'families left without a brief looked like a clean run').toBe(502);
    expect(body.briefs.families).toBe(12);
    expect(body.briefs.delivered).toBe(h.briefed.length);
    expect(body.briefs.delivered).toBeLessThan(12);
    expect(body.briefs.delivered + body.briefs.failed, 'a family was neither briefed nor counted').toBe(12);
  });

  it('rotates where it starts, so the same families are not left without a brief every morning', async () => {
    db.seed('families', families(12).map((id) => ({ id, closed_at: null, timezone: 'UTC' })));
    h.briefTakesMs = 30_000;
    await within(1_000);
    const firstMorning = [...h.briefed].sort();
    h.briefed = [];
    vi.setSystemTime(new Date('2026-10-21T11:00:00.000Z'));
    await within(1_000);
    expect([...h.briefed].sort(), 'the same families were briefed and the same ones never').not.toEqual(firstMorning);
  });
});

describe('a pass inside its slice (control)', () => {
  it('briefs every family and answers 200', async () => {
    db.seed('families', families(3).map((id) => ({ id, closed_at: null, timezone: 'UTC' })));
    const { settled, response } = await within(1_000);
    expect(settled).toBe(true);
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, briefs: { delivered: 3, families: 3, skipped: 0, failed: 0 } });
  });
});
