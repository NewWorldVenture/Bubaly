import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Closing an account sets `families.closed_at` (app/(app)/account/actions.ts),
 * and the product presents it as a pause: "Take a break anytime ... reopen
 * whenever you like and pick up right where you left off." Every screen is
 * behind the closed-account gate from then on.
 *
 * None of the crons that send to families read it. A closed family kept
 * getting the Monday digest, the Sunday chore reminders, the daily morning
 * brief, and every reminder the notification engine generates, pushed to
 * their phones and emailed, each one linking to a gate.
 *
 * Each of those five reads of `families` now skips a closed family. The
 * reads stay in their own files: tests/whole-table-reads-are-not-capped.test.ts
 * pins `from('families')` in each of them.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  users: [] as { id: string; email: string | null }[],
  sends: [] as string[],
  generatedFor: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: async () => ({ users: h.users, error: null }) }));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async ({ to }: { to: string }) => { h.sends.push(to); return { ok: true }; },
}));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  readCompleteCalendarOccurrences: async () => ({ ok: true, data: { occurrences: [], totalVisibleCount: 0, horizonEndsAt: '' } }),
}));
// The notification engine, its delivery and the sweeps beside it are not what
// is under test here: which families the two notification crons walk is.
vi.mock('@/lib/server/notifications', () => ({
  generateFamilyNotifications: async (_db: unknown, familyId: string) => { h.generatedFor.push(familyId); return 0; },
}));
vi.mock('@/lib/server/push', () => ({
  dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }),
}));
vi.mock('@/lib/server/notification-emails', () => ({ deliverNotificationEmails: async () => ({ sent: 0, failed: 0, skipped: 0 }) }));
vi.mock('@/lib/services/approvals', () => ({
  expireStale: async () => ({ expired: 0, blockedRuns: 0 }),
  remindPendingApprovals: async () => ({ reminded: 0, families: 0 }),
}));
vi.mock('@/lib/services/tasks', () => ({
  respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, failed: 0 } }),
}));
vi.mock('@/lib/briefing/deliver', async () => {
  const actual = await vi.importActual<typeof import('@/lib/briefing/deliver')>('@/lib/briefing/deliver');
  return { ...actual, deliverMorningBriefs: async () => ({ delivered: 0, families: 0, skipped: 0, failed: 0 }) };
});

import { GET as weeklyDigest } from '@/app/api/cron/weekly-digest/route';
import { GET as choreReminders } from '@/app/api/cron/chore-reminders/route';
import { GET as notificationsCron } from '@/app/api/cron/notifications/route';
import { GET as pushScan } from '@/app/api/cron/push-scan/route';

type DB = SupabaseClient<Database>;
const ROOT = join(__dirname, '..');
const OPEN = 'fam-open';
const CLOSED = 'fam-closed';
const req = (path: string) => new Request(`https://bubaly.test/api/cron/${path}`) as never;

function seed(): InMemorySupabase {
  const db = createInMemorySupabase();
  db.seed('families', [
    { id: OPEN, name: 'Open family', timezone: 'UTC', closed_at: null },
    { id: CLOSED, name: 'Closed family', timezone: 'UTC', closed_at: '2026-09-01T00:00:00.000Z' },
  ]);
  db.seed('family_members', [
    { id: 'm-open', family_id: OPEN, user_id: 'u-open', display_name: 'Open parent', role: 'parent', is_active: true },
    { id: 'm-closed', family_id: CLOSED, user_id: 'u-closed', display_name: 'Closed parent', role: 'parent', is_active: true },
  ]);
  db.seed('chores', [{ id: 'c-1', family_id: OPEN, title: 'Synthetic chore', points: 5 }]);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  // `family_member_id` only lets the fake resolve the `family_members!member_id`
  // embed, whose key it cannot read from the hint.
  db.seed('chore_assignments', [
    { id: 'a-open', family_id: OPEN, member_id: 'm-open', family_member_id: 'm-open', chore_id: 'c-1', status: 'todo', due_at: tomorrow },
    { id: 'a-closed', family_id: CLOSED, member_id: 'm-closed', family_member_id: 'm-closed', chore_id: 'c-1', status: 'todo', due_at: tomorrow },
  ]);
  return db;
}

beforeEach(() => {
  h.db = seed();
  h.users = [{ id: 'u-open', email: 'open@synthetic.invalid' }, { id: 'u-closed', email: 'closed@synthetic.invalid' }];
  h.sends = [];
  h.generatedFor = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a family that closed its account', () => {
  it('gets no weekly digest', async () => {
    const res = await weeklyDigest(req('weekly-digest'));
    expect(h.sends, 'emailed a closed family its week ahead').toEqual(['open@synthetic.invalid']);
    expect(res.status).toBe(200);
  });

  it('gets no chore reminders', async () => {
    const res = await choreReminders(req('chore-reminders'));
    expect(h.sends, 'reminded a closed family of its chores').toEqual(['open@synthetic.invalid']);
    expect(res.status).toBe(200);
  });

  it('gets no notifications generated by the daily notification cron', async () => {
    await notificationsCron(req('notifications'));
    expect(h.generatedFor).toEqual([OPEN]);
  });

  it('gets no notifications generated by the push scan', async () => {
    await pushScan(req('push-scan'));
    expect(h.generatedFor).toEqual([OPEN]);
  });

  it('gets no morning brief', async () => {
    const { deliverMorningBriefs } = await vi.importActual<typeof import('@/lib/briefing/deliver')>('@/lib/briefing/deliver');
    const db = h.db as InMemorySupabase;
    const result = await deliverMorningBriefs(db as unknown as DB, new Date('2026-09-07T11:00:00Z'));
    expect(result.families).toBe(1);
    expect(db.table('notifications').filter((n) => n.family_id === CLOSED)).toEqual([]);
  });

  it('is sent to again once it reopens', async () => {
    const db = h.db as InMemorySupabase;
    db.table('families').find((f) => f.id === CLOSED)!.closed_at = null;
    await weeklyDigest(req('weekly-digest'));
    expect(h.sends.sort()).toEqual(['closed@synthetic.invalid', 'open@synthetic.invalid']);
  });
});

describe('every cron that sends to families reads closed_at', () => {
  // A sixth sender that walks `families` must make the same choice.
  const SENDERS = [
    'app/api/cron/weekly-digest/route.ts',
    'app/api/cron/chore-reminders/route.ts',
    'app/api/cron/notifications/route.ts',
    'app/api/cron/push-scan/route.ts',
    'lib/briefing/deliver.ts',
  ];
  it.each(SENDERS)('%s', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const marker = "from('families')";
    const chains: string[] = [];
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      chains.push(source.slice(at, source.indexOf(';', at)));
    }
    expect(chains.length, `${file} no longer reads families`).toBeGreaterThan(0);
    for (const chain of chains) expect(chain, file).toMatch(/closed_at/);
  });
});
