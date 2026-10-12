import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A family that closed its account (families.closed_at) is left alone by the
 * scheduled jobs. closeAccountAction set closed_at and nothing read it: the
 * push scan kept generating and pushing to the family's devices, provider sync
 * kept using their stored OAuth tokens, and the allowance cron kept crediting
 * wallets for any family whose subscription row still said paid. (The weekly
 * digest's half is in the-weekly-digest-reaches-every-family.test.ts.)
 *
 * Every case seeds one OPEN and one CLOSED family with the same rows and
 * asserts the job reached only the open one — so each fails when its filter is
 * taken away.
 */

type DB = SupabaseClient<Database>;

const OPEN = 'family-open';
const CLOSED = 'family-closed';
const TODAY = '2026-09-28';
const NOW_ISO = `${TODAY}T12:00:00.000Z`;
const KINDS = ['spend', 'save', 'give', 'invest'] as const;
const FAMILIES = [OPEN, CLOSED] as const;
// Real uuids, for the queues whose cursors validate them.
const UUID = { [OPEN]: '00000000-0000-4000-8000-000000000001', [CLOSED]: '00000000-0000-4000-8000-000000000002' } as const;

const harness = vi.hoisted(() => ({
  db: null as unknown,
  generatedFor: [] as string[],
  syncedFor: [] as string[],
  emailedTo: [] as string[],
  calledFor: {} as Record<string, string[]>,
  autopilotTier: 'plus' as string,
  claimed: [] as { id: string; familyId: string; leaseOwner: string | null }[],
}));
const record = (job: string, familyId: string) => { (harness.calledFor[job] ??= []).push(familyId); };

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/notifications', () => ({
  generateFamilyNotifications: async (_db: unknown, familyId: string) => { harness.generatedFor.push(familyId); return 0; },
}));
vi.mock('@/lib/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/scope')>()),
  systemScopeForFamily: async () => null,
}));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, failed: 0 } }) }));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ isConfigured: () => true }) }));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_db: unknown, account: { family_id: string }) => {
    harness.syncedFor.push(account.family_id);
    return { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  },
}));
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  emailEnabled: () => true,
  sendReactEmail: async ({ to }: { to: string }) => { harness.emailedTo.push(to); return { ok: true }; },
}));
vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: FAMILIES_FOR_AUTH.map((f) => ({ id: `user-${f}`, email: `${f}@bubaly.test` })), error: null }),
}));
vi.mock('@/lib/notifications/child-channels', () => ({ childrenBlockedOn: async () => new Set<string>() }));
vi.mock('@/lib/server/calendar-feeds', () => ({
  syncFeed: async (_db: unknown, feed: { family_id: string }) => { record('calendar-feeds', feed.family_id); return { ok: true, imported: 0 }; },
}));
vi.mock('@/lib/library/ingest', () => ({
  FEED_UNREADABLE: 'unreadable',
  ingestFeed: async (_db: unknown, familyId: string) => { record('library-feeds', familyId); return { added: 0 }; },
  recordFeedError: async () => {},
}));
vi.mock('@/lib/guardian/learning-run', () => ({
  runLearningForFamily: async (_db: unknown, familyId: string) => { record('guardian-learning', familyId); return { created: 0 }; },
}));
vi.mock('@/lib/twin/project-server', () => ({
  runTwinProjection: async (_db: unknown, familyId: string) => { record('model-refresh', familyId); return { ok: true, entities: 0, edges: 0 }; },
}));
vi.mock('@/lib/planning/prep-server', () => ({ runPrepGeneration: async () => ({ ok: true, plans: 0 }) }));
vi.mock('@/lib/intelligence/hard-signals-server', () => ({ runSignalDetection: async () => ({}) }));
vi.mock('@/lib/autopilot/scan', () => ({
  runAutopilotScan: async (_db: unknown, familyId: string) => {
    record('autopilot-scan', familyId);
    return { scanned: 0, autoExecuted: 0, notified: 0, policyCandidates: 0 };
  },
}));
vi.mock('@/lib/server/feature-entitlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/feature-entitlement')>()),
  getFeatureTiersByHref: async () => ({ '/dashboard/autopilot': harness.autopilotTier }),
}));
vi.mock('@/lib/services/ai-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/ai-settings')>()),
  // Bubaly switched off: the routine is reserved, stamped skipped and moved on,
  // which is all this file needs to see whom the tick reached.
  loadAISettings: async () => ({ ok: true, data: { enabled: false } }),
}));
vi.mock('@/lib/ai/runs/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/runs/store')>()),
  claimRuns: async () => {
    const wave = harness.claimed;
    harness.claimed = [];
    return { ok: true, data: wave };
  },
  releaseRun: async () => {},
}));
vi.mock('@/lib/ai/runs/executor', () => ({
  runGraph: async (runId: string) => { record('ai-runs', runId); return { status: 'completed', completed: 1, failed: 0 }; },
}));
vi.mock('@/lib/ai/planner/replan-port', () => ({ replanPortFor: () => null }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => undefined, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/marketing/automation-steps', () => ({
  runSteps: async (_steps: unknown, recipient: { email: string | null }) => { harness.emailedTo.push(recipient.email ?? ''); return ['send_email']; },
}));

const FAMILIES_FOR_AUTH = FAMILIES;

const { GET: pushScan } = await import('@/app/api/cron/push-scan/route');
const { GET: providerSync } = await import('@/app/api/cron/provider-sync/route');
const { GET: walletAllowance } = await import('@/app/api/cron/wallet-allowance/route');
const { GET: notificationsCron } = await import('@/app/api/cron/notifications/route');
const { GET: choreReminders } = await import('@/app/api/cron/chore-reminders/route');
const { GET: calendarFeeds } = await import('@/app/api/cron/calendar-feeds/route');
const { GET: familyRoutines } = await import('@/app/api/cron/family-routines/route');
const { GET: autopilotScan } = await import('@/app/api/cron/autopilot-scan/route');
const { GET: modelRefresh } = await import('@/app/api/cron/model-refresh/route');
const { GET: libraryFeeds } = await import('@/app/api/cron/library-feeds/route');
const { GET: guardianLearning } = await import('@/app/api/cron/guardian-learning/route');
const { GET: aiRuns } = await import('@/app/api/cron/ai-runs/route');
const { dispatchPendingPushes } = await import('@/lib/server/push');
const { deliverNotificationEmails } = await import('@/lib/server/notification-emails');
const { deliverMorningBriefs } = await import('@/lib/briefing/deliver');
const { remindPendingApprovals } = await import('@/lib/services/approvals');
const { runNetworkAggregation } = await import('@/lib/network/aggregate-server');
const { runScheduledPublishDrain } = await import('@/lib/social/scheduled-publish');
const { drainUrgentDeliveries } = await import('@/lib/contact-center/urgent-delivery');
const { runAutomations } = await import('@/lib/marketing/automation-runner');

const request = () => new Request('https://bubaly.test/api/cron') as never;
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.generatedFor = [];
  harness.syncedFor = [];
  harness.emailedTo = [];
  harness.calledFor = {};
  harness.autopilotTier = 'plus';
  harness.claimed = [];
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('families', [
    { id: OPEN, name: 'Open', timezone: 'UTC', trial_ends_at: null, closed_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: CLOSED, name: 'Closed', timezone: 'UTC', trial_ends_at: null, closed_at: '2026-09-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  ]);
  for (const family of FAMILIES) {
    db.seed('subscriptions', [{ id: `sub-${family}`, family_id: family, plan: 'plus', status: 'active', created_at: '2026-01-01T00:00:00.000Z' }]);
    db.seed('family_members', [{ id: `parent-${family}`, family_id: family, user_id: `user-${family}`, role: 'parent', is_active: true, display_name: 'Parent' }]);
    db.seed('profiles', [{ id: `user-${family}`, email: `${family}@bubaly.test` }]);
    db.seed('child_wallets', [{ id: `wallet-${family}`, family_id: family, member_id: `child-${family}` }]);
    db.seed('wallet_buckets', KINDS.map((kind) => ({ id: `wallet-${family}-${kind}`, family_id: family, child_wallet_id: `wallet-${family}`, kind })));
    db.seed('allowance_rules', [{
      id: `rule-${family}`, family_id: family, child_wallet_id: `wallet-${family}`, amount_cents: 1_500, cadence: 'weekly', split: null,
      is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21', created_by: `user-${family}`,
    }]);
    db.seed('sync_accounts', [{
      id: `sync-${family}`, user_id: `user-${family}`, family_id: family, external_id: 'x', provider: 'google',
      sync_direction: 'two_way', last_synced_at: null,
    }]);
  }
});

afterEach(() => { vi.useRealTimers(); });

describe('a closed family is left alone by the scheduled jobs', () => {
  it('push-scan generates nothing for a closed family', async () => {
    const res = await pushScan(request());
    expect((await res.json()).families).toBe(1);
    expect(harness.generatedFor).toEqual([OPEN]);
  });

  it('provider-sync does not sync a closed family\'s accounts', async () => {
    const res = await providerSync(request());
    expect((await res.json()).scanned).toBe(1);
    expect(harness.syncedFor).toEqual([OPEN]);
  });

  it('wallet-allowance does not pay a closed family\'s allowance, even on a paid plan', async () => {
    await walletAllowance(request());
    const paidFamilies = new Set(db.table('wallet_transactions').map((t) => t.family_id));
    expect([...paidFamilies]).toEqual([OPEN]);
    expect(db.table('allowance_rules').find((r) => r.id === `rule-${CLOSED}`)?.next_run_on).toBe(TODAY);
  });

  it('the notifications cron generates nothing for a closed family', async () => {
    const res = await notificationsCron(request());
    expect((await res.json()).families).toBe(1);
    expect(harness.generatedFor).toEqual([OPEN]);
  });

  it('push dispatch does not push a closed family\'s queued notifications', async () => {
    for (const family of FAMILIES) {
      db.seed('notifications', [{
        id: UUID[family], family_id: family, user_id: null, title: 'Hi', body: null, related_type: null, related_id: null,
        created_at: '2026-09-28T11:00:00.000Z', send_at: '2026-09-28T11:00:00.000Z', pushed_at: null,
      }]);
    }
    const { notifications } = await dispatchPendingPushes(asDb());
    expect(notifications).toBe(1);
    expect(db.table('notifications').find((n) => n.id === UUID[OPEN])?.pushed_at).toBeTruthy();
    expect(db.table('notifications').find((n) => n.id === UUID[CLOSED])?.pushed_at).toBeNull();
  });

  it('the email digest does not email a closed family', async () => {
    for (const family of FAMILIES) {
      db.seed('notifications', [{
        id: `n-${family}`, family_id: family, user_id: `user-${family}`, type: 'system', title: 'Hi', body: null, related_type: null,
        created_at: '2026-09-28T11:00:00.000Z', send_at: '2026-09-28T11:00:00.000Z', sent_at: null,
      }]);
    }
    await deliverNotificationEmails(asDb());
    expect(harness.emailedTo).toEqual([`${OPEN}@bubaly.test`]);
    expect(db.table('notifications').find((n) => n.id === `n-${CLOSED}`)?.sent_at).toBeNull();
  });

  it('the morning brief is not delivered to a closed family', async () => {
    const result = await deliverMorningBriefs(asDb(), new Date(NOW_ISO));
    expect(result.families).toBe(1);
  });

  it('approval reminders do not reach a closed family\'s managers', async () => {
    for (const family of FAMILIES) {
      db.seed('approval_requests', [{
        id: `appr-${family}`, family_id: family, status: 'pending', requested_by_kind: 'ai', title: 'Add soccer Saturday',
        amount_cents: null, created_at: '2026-09-28T10:00:00.000Z', expires_at: null, agent: null,
      }]);
    }
    const result = await remindPendingApprovals(asDb(), new Date(NOW_ISO));
    expect(result.families).toBe(1);
    expect([...new Set(db.table('notifications').map((n) => n.family_id))]).toEqual([OPEN]);
  });

  it('chore-reminders does not email a closed family\'s members', async () => {
    for (const family of FAMILIES) {
      db.seed('chores', [{ id: `chore-${family}`, family_id: family, title: 'Dishes', points: 5 }]);
      db.seed('chore_assignments', [{
        id: `ca-${family}`, family_id: family, chore_id: `chore-${family}`, member_id: `parent-${family}`, status: 'todo',
        due_at: '2026-09-30T12:00:00.000Z',
        // The fake resolves an embed by `<table>_id`, not by the `!member_id`
        // hint the route names; this column is that link, for the fake only.
        family_member_id: `parent-${family}`,
      }]);
    }
    const res = await choreReminders(request());
    expect((await res.json()).sent).toBe(1);
    expect(harness.emailedTo).toEqual([`${OPEN}@bubaly.test`]);
  });

  it('calendar-feeds does not refresh a closed family\'s feeds', async () => {
    for (const family of FAMILIES) db.seed('calendar_feeds', [{ id: `feed-${family}`, family_id: family, url: 'https://example.test/cal.ics' }]);
    const res = await calendarFeeds(request());
    expect((await res.json()).feeds).toBe(1);
    expect(harness.calledFor['calendar-feeds']).toEqual([OPEN]);
  });

  it('family-routines neither fires nor arms a closed family\'s routines', async () => {
    for (const family of FAMILIES) {
      db.seed('family_automation_rules', [
        {
          id: `due-${family}`, family_id: family, name: 'Plan meals', action_config: {}, schedule_kind: 'cron', schedule_expr: '0 9 * * *',
          anchor_key: null, offset_days: null, at_hour: null, said: 'every day at 9', is_enabled: true, next_run_at: '2026-09-28T09:00:00.000Z',
        },
        {
          id: `unarmed-${family}`, family_id: family, name: 'Plan meals', action_config: {}, schedule_kind: 'cron', schedule_expr: '0 9 * * *',
          anchor_key: null, offset_days: null, at_hour: null, said: 'every day at 9', is_enabled: true, next_run_at: null,
        },
      ]);
    }
    const body = await (await familyRoutines(request())).json();
    expect(body.considered).toBe(1);
    expect(body.armed).toBe(1);
    expect(db.table('routine_runs').map((r) => r.family_id)).toEqual([OPEN]);
    expect(db.table('family_automation_rules').find((r) => r.id === `unarmed-${CLOSED}`)?.next_run_at).toBeNull();
    expect(db.table('family_automation_rules').find((r) => r.id === `unarmed-${OPEN}`)?.next_run_at).toBeTruthy();
  });

  it('autopilot-scan: the entitlement check alone skips a closed family only while Autopilot needs a paid plan', async () => {
    // At the catalogue's 'plus' tier a closed family resolves to level 0 and is
    // skipped by the entitlement check — confirmed here, so the explicit filter
    // is known to be the second guard rather than the only one.
    await autopilotScan(request());
    expect(harness.calledFor['autopilot-scan']).toEqual([OPEN]);
    // An admin can put Autopilot on the free tier. Level 0 then passes the
    // entitlement check, and only the closed_at filter keeps the scan away.
    harness.calledFor = {};
    harness.autopilotTier = 'free';
    const body = await (await autopilotScan(request())).json();
    expect(body.families).toBe(1);
    expect(harness.calledFor['autopilot-scan']).toEqual([OPEN]);
  });

  it('model-refresh does not model a closed family', async () => {
    const body = await (await modelRefresh(request())).json();
    expect(harness.calledFor['model-refresh']).toEqual([OPEN]);
    expect(body.ok).toBe(true);
  });

  it('library-feeds does not fetch a closed family\'s podcasts', async () => {
    for (const family of FAMILIES) {
      db.seed('library_feeds', [{ id: `lib-${family}`, family_id: family, feed_url: 'https://example.test/feed', created_by: null, last_fetched_at: null }]);
    }
    const body = await (await libraryFeeds(request())).json();
    expect(body.feeds).toBe(1);
    expect(harness.calledFor['library-feeds']).toEqual([OPEN]);
  });

  it('guardian-learning makes no suggestions for a closed family', async () => {
    for (const family of FAMILIES) {
      db.seed('guardian_communications', [{ id: `gc-${family}`, family_id: family, started_at: '2026-09-20T00:00:00.000Z' }]);
    }
    const body = await (await guardianLearning(request())).json();
    expect(body.families).toBe(1);
    expect(harness.calledFor['guardian-learning']).toEqual([OPEN]);
  });

  it('ai-runs does not execute a closed family\'s run, and puts it back a day out rather than cancelling it', async () => {
    for (const family of FAMILIES) {
      db.seed('family_automation_runs', [{ id: `run-${family}`, family_id: family, state: 'executing', status: 'running', lease_owner: 'w', run_after: null }]);
    }
    harness.claimed = FAMILIES.map((family) => ({ id: `run-${family}`, familyId: family, leaseOwner: 'w' }));
    const body = await (await aiRuns(request())).json();
    expect(harness.calledFor['ai-runs']).toEqual([`run-${OPEN}`]);
    expect(body.deferredClosed).toBe(1);
    const parked = db.table('family_automation_runs').find((r) => r.id === `run-${CLOSED}`)!;
    expect(parked.state).toBe('ready');
    expect(Date.parse(parked.run_after as string)).toBeGreaterThan(Date.parse(NOW_ISO) + 23 * 3_600_000);
  });

  it('network aggregation takes nothing from a closed family, and prunes what it gave before closing', async () => {
    for (const family of FAMILIES) db.seed('network_consent', [{ family_id: family, enabled: true, scopes: {} }]);
    db.seed('network_contributions', [{ family_id: CLOSED, cohort_key: 'x', features: {}, metrics: {}, scopes: {} }]);
    await runNetworkAggregation(asDb(), new Date(NOW_ISO));
    expect(db.table('network_contributions').map((c) => c.family_id)).toEqual([OPEN]);
  });

  it('the scheduled social publisher does not look at a closed family\'s queued posts', async () => {
    for (const family of FAMILIES) {
      db.seed('ai_tool_calls', [{ id: UUID[family], family_id: family, tool_name: 'social.scheduled_publish', outputs: { drain: true }, created_at: '2026-09-28T10:00:00.000Z' }]);
    }
    const summary = await runScheduledPublishDrain({ now: new Date(NOW_ISO) });
    expect(summary.inspected).toBe(1);
  });

  it('the urgent contact-center drain does not forward a closed family\'s messages', async () => {
    for (const family of FAMILIES) {
      db.seed('ai_tool_calls', [{ id: UUID[family], family_id: family, tool_name: 'contact_center.urgent_delivery', outputs: { drain: true }, created_at: '2026-09-28T10:00:00.000Z' }]);
    }
    const counts = await drainUrgentDeliveries(asDb() as never, { now: new Date(NOW_ISO) });
    expect(counts.examined).toBe(1);
  });

  it('marketing automations do not email a closed family', async () => {
    db.seed('marketing_automation_workflows', [{ id: 'wf-1', trigger: 'customer_inactive', steps: [], run_count: 0, status: 'active', deleted_at: null }]);
    await runAutomations(asDb());
    expect(harness.emailedTo).toEqual([`${OPEN}@bubaly.test`]);
    expect(db.table('marketing_automation_runs').map((r) => r.subject_key)).toEqual([OPEN]);
  });
});
