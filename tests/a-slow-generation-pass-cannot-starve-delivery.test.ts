// A slow generation pass cannot starve the day's delivery.
//
// /api/cron/notifications and /api/cron/push-scan awaited
// generateFamilyNotifications for every open family, one at a time, in
// `order('id')`, with no maxDuration, no budget and no per-family timeout — and
// only AFTER that loop did push dispatch (and, on the daily run, the email
// digests) run. One family whose reads hung, or enough families at a dozen
// reads each, ran the function into the platform's kill before delivery was
// reached: no device on the platform was pushed that tick, no family got its
// daily email, there was no response to count it, and the same tail of
// families was never generated for.
//
// Behavioural, with the clock and timers faked: a family that never answers
// costs its own timeout and is counted as its own failure while the run goes
// on to deliver; a budget that runs out leaves the tail counted `unserved`
// with a 502, and delivery still runs for the rows already queued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  generated: [] as string[],
  hang: new Set<string>(),
  /** Each generation moves the clock this far: how a run outgrows its budget. */
  generationTakesMs: 0,
  pushDispatches: 0,
  emailDeliveries: 0,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/notifications', () => ({
  generateFamilyNotifications: async (_db: unknown, familyId: string) => {
    if (h.hang.has(familyId)) return new Promise<number>(() => {});
    h.generated.push(familyId);
    if (h.generationTakesMs) vi.setSystemTime(Date.now() + h.generationTakesMs);
    return 1;
  },
}));
vi.mock('@/lib/server/push', () => ({
  dispatchPendingPushes: async () => { h.pushDispatches += 1; return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }; },
}));
vi.mock('@/lib/server/notification-emails', () => ({
  deliverNotificationEmails: async () => { h.emailDeliveries += 1; return { sent: 0, failed: 0, skipped: 0 }; },
}));
vi.mock('@/lib/briefing/deliver', () => ({ deliverMorningBriefs: async () => ({ delivered: 0, families: 0, skipped: 0, failed: 0 }) }));
vi.mock('@/lib/services/approvals', () => ({
  expireStale: async () => ({ expired: 0, blockedRuns: 0, failures: 0 }),
  resumeSettledRuns: async () => ({ resumed: 0, failures: 0 }),
  remindPendingApprovals: async () => ({ reminded: 0, families: 0, failures: 0 }),
}));
vi.mock('@/lib/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/scope')>()),
  systemScopeForFamily: async (_db: unknown, familyId: string) => ({ familyId }),
}));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, failed: 0 } }) }));

const { GET: notifications } = await import('@/app/api/cron/notifications/route');
const { GET: pushScan } = await import('@/app/api/cron/push-scan/route');
const notificationsRoute = await import('@/app/api/cron/notifications/route');
const pushScanRoute = await import('@/app/api/cron/push-scan/route');

let db: InMemorySupabase;
const req = (path: string) => new Request(`https://bubaly.test${path}`) as never;
const families = (n: number) => Array.from({ length: n }, (_, i) => `fam-${String(i).padStart(2, '0')}`);

/** Runs the route and lets `ms` of faked time pass; says whether it answered. */
async function within(ms: number, run: () => Promise<Response>): Promise<{ settled: boolean; response?: Response }> {
  let response: Response | undefined;
  const pending = run().then((r) => { response = r; });
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.race([pending, Promise.resolve()]);
  return { settled: response !== undefined, response };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T11:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.generated = []; h.hang = new Set(); h.generationTakesMs = 0; h.pushDispatches = 0; h.emailDeliveries = 0;
  db = createInMemorySupabase();
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one family whose reads never answer', () => {
  it('notifications: costs its own timeout and its own failure; every other family is generated for, and pushes and emails still go out', async () => {
    db.seed('families', families(3).map((id) => ({ id, closed_at: null })));
    h.hang.add('fam-01');

    const { settled, response } = await within(60_000, () => notifications(req('/api/cron/notifications')));
    expect(settled, 'the run hung behind one family and delivered nothing').toBe(true);
    expect(h.generated.sort()).toEqual(['fam-00', 'fam-02']);
    expect(h.pushDispatches).toBe(1);
    expect(h.emailDeliveries).toBe(1);
    expect(response!.status).toBe(502);
    expect(await response!.json()).toMatchObject({ ok: false, created: 2, unserved: 0, failed: 1 });
  });

  it('push-scan: the same, and the queued pushes still go out', async () => {
    db.seed('families', families(3).map((id) => ({ id, closed_at: null })));
    h.hang.add('fam-01');

    const { settled, response } = await within(60_000, () => pushScan(req('/api/cron/push-scan')));
    expect(settled, 'the run hung behind one family and pushed nobody').toBe(true);
    expect(h.generated.sort()).toEqual(['fam-00', 'fam-02']);
    expect(h.pushDispatches).toBe(1);
    expect(response!.status).toBe(502);
    expect(await response!.json()).toMatchObject({ ok: false, created: 2, unserved: 0, failed: 1 });
  });
});

describe('a generation pass that outgrows its budget', () => {
  it('notifications: stops starting families, reports the tail as unserved with a 502, and still delivers', async () => {
    db.seed('families', families(6).map((id) => ({ id, closed_at: null })));
    h.generationTakesMs = 160_000; // the first wave alone spends the budget

    const { settled, response } = await within(1_000, () => notifications(req('/api/cron/notifications')));
    expect(settled).toBe(true);
    const body = await response!.json();
    expect(response!.status, 'an unserved tail looked like a clean run').toBe(502);
    expect(body).toMatchObject({ ok: false, unserved: 2, failed: 2 });
    expect(h.generated).toHaveLength(4);
    expect(h.pushDispatches).toBe(1);
    expect(h.emailDeliveries).toBe(1);
  });

  it('push-scan: the same', async () => {
    db.seed('families', families(6).map((id) => ({ id, closed_at: null })));
    h.generationTakesMs = 70_000;

    const { settled, response } = await within(1_000, () => pushScan(req('/api/cron/push-scan')));
    expect(settled).toBe(true);
    expect(response!.status).toBe(502);
    expect(await response!.json()).toMatchObject({ ok: false, unserved: 2, failed: 2 });
    expect(h.pushDispatches).toBe(1);
  });

  it('rotates where it starts, so the same tail is not cut off every run', async () => {
    db.seed('families', families(6).map((id) => ({ id, closed_at: null })));
    h.generationTakesMs = 160_000;
    await within(1_000, () => notifications(req('/api/cron/notifications')));
    const firstRun = [...h.generated].sort();
    h.generated = [];
    vi.setSystemTime(new Date('2026-10-21T11:00:00.000Z'));
    await within(1_000, () => notifications(req('/api/cron/notifications')));
    expect([...h.generated].sort(), 'the same four families were served and the same two never').not.toEqual(firstRun);
  });
});

describe('both routes declare their limit', () => {
  it('rather than inheriting the platform default', () => {
    expect(notificationsRoute.maxDuration).toBe(300);
    expect(pushScanRoute.maxDuration).toBe(120);
  });
});
