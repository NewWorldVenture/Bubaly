import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { DoseLogLite, MedLite } from '@/lib/notifications/medication-reminders';

type Member = Pick<Database['public']['Tables']['family_members']['Row'], 'id' | 'user_id' | 'role' | 'display_name' | 'birthday'>;
type Notification = Database['public']['Tables']['notifications']['Row'];
type Call = { table: string; method: string; query: string };
const h = vi.hoisted(() => ({
  db: null as SupabaseClient<Database> | null,
  calls: [] as Call[], rows: [] as Notification[], members: [] as Member[],
  meds: [] as MedLite[], doses: [] as DoseLogLite[], failRoster: false,
}));

// The generator, reminder builder, scope/time helpers, unread service and SDK
// execute normally. Other reminder categories and delivery timing are outside
// this recipient-boundary test. No transport can leave the synthetic origin.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/i18n/messages', () => ({ SOURCE_MESSAGES: {}, translate: (_messages: unknown, key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: vi.fn() }));
vi.mock('@/lib/services/notifications', async (original) => ({
  ...(await original<typeof import('@/lib/services/notifications')>()),
  deliveryTimeFor: async () => ({ sendAt: new Date().toISOString() }),
}));
vi.mock('@/lib/notifications/deadline-reminders', () => ({ renewalReminders: () => [], opportunityReminders: () => [] }));
vi.mock('@/lib/notifications/approval-reminders', () => ({ approvalReminders: () => [] }));
vi.mock('@/lib/home/conflicts', () => ({ detectConflicts: () => [] }));
vi.mock('@/lib/relationship/dates', () => ({ upcomingRelationship: () => [], formatCountdown: () => '', milestoneLabel: () => '' }));
vi.mock('@/lib/reminders/notify', () => ({ dueFamilyReminderNotices: () => [], reminderFetchHorizonIso: () => '2026-10-01T00:00:00Z' }));
vi.mock('@/lib/memories/on-this-day', () => ({ onThisDayNotice: () => null }));
vi.mock('@/lib/moments/notify', () => ({ imminentMomentNotices: () => [] }));

const { generateFamilyNotifications } = await import('@/lib/server/notifications');
const { listUnread } = await import('@/lib/services/notifications');
const NOW = '2026-09-30T12:00:00.000Z';
const FAMILY = 'family-A';
const med: MedLite = { id: 'med-child', name: 'Synthetic private prescription', dosage: 'synthetic dosage', member_id: 'managed-child', is_active: true };
const schedule = { id: 'schedule-child', medication_id: med.id, time_of_day: '08:00:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null };
const emptySources = ['calendar_events', 'chore_assignments', 'school_events', 'sports_events', 'reminders', 'documents', 'renewals', 'opportunities', 'parent_approvals', 'relationship_dates', 'family_reminders', 'family_photos'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Retain the hosted-test backstop; an external immutable seal already owns
  // fetch in the independent review harness and must not be replaced.
  if (Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.configurable !== false) {
    vi.stubGlobal('fetch', () => { throw new Error('External network is forbidden'); });
  }
  h.calls = []; h.rows = []; h.failRoster = false; h.meds = [{ ...med }]; h.doses = [];
  h.members = [
    { id: 'manager-1', user_id: 'user-parent', role: 'parent', display_name: 'Parent', birthday: null },
    { id: 'manager-2', user_id: 'user-adult', role: 'adult', display_name: 'Adult', birthday: null },
    { id: 'sibling', user_id: 'user-sibling', role: 'child', display_name: 'Sibling', birthday: null },
    { id: 'managed-child', user_id: null, role: 'child', display_name: 'Managed child', birthday: null },
  ];
  h.db = createClient<Database>('https://bubaly-review.example.test', 'synthetic-non-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.origin !== 'https://bubaly-review.example.test' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport destination');
      const table = url.pathname.slice('/rest/v1/'.length);
      const method = init?.method ?? 'GET';
      h.calls.push({ table, method, query: url.search });
      if (method === 'POST') {
        if (table !== 'notifications') throw new Error(`Unexpected write: ${table}`);
        const body = JSON.parse(String(init?.body)) as Notification[];
        if (!Array.isArray(body)) throw new Error('Expected notification batch');
        h.rows.push(...body.map((row, i) => ({ ...row, id: `notice-${h.rows.length + i}`, is_read: false, created_at: NOW })));
        return new Response(null, { status: 201 });
      }
      if (method !== 'GET') throw new Error(`Unexpected method: ${method}`);
      if (table === 'family_members' && h.failRoster) {
        return new Response(JSON.stringify({ code: '57014', message: 'synthetic roster failure' }), { status: 500 });
      }
      let result: unknown[];
      if (table === 'families') result = [{ id: FAMILY, name: 'Synthetic family', timezone: 'UTC' }];
      else if (table === 'family_members') {
        expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
        expect(url.searchParams.get('is_active')).toBe('eq.true');
        let roster = [...h.members];
        if (url.searchParams.get('order') === 'id.asc') roster.sort((a, b) => a.id.localeCompare(b.id));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? Infinity);
        const columns = (url.searchParams.get('select') ?? '*').split(',');
        result = roster.slice(offset, offset + limit).map(member => columns.includes('*') ? member
          : Object.fromEntries(columns.map(column => [column, member[column as keyof Member] ?? null])));
      }
      else if (table === 'medications') result = h.meds;
      else if (table === 'medication_schedules') result = [schedule];
      else if (table === 'medication_doses') result = h.doses;
      else if (table === 'notifications') {
        let rows = h.rows.filter(row => url.searchParams.get('family_id') === `eq.${row.family_id}`);
        const userFilter = url.searchParams.get('or');
        if (userFilter) {
          const match = /^\(user_id\.eq\.([^,]+),user_id\.is\.null\)$/.exec(userFilter);
          if (!match) throw new Error('Unexpected recipient filter');
          rows = rows.filter(row => row.user_id === match[1] || row.user_id === null);
        }
        result = rows;
      } else if (emptySources.includes(table)) result = [];
      else throw new Error(`Unexpected read: ${table}`);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function unread(userId: string, familyId = FAMILY) {
  const result = await listUnread({ db: h.db!, familyId, userId, memberId: 'sibling', role: 'child', actorKind: 'member', tz: 'UTC', now: new Date(NOW) });
  if (!result.ok) throw new Error('Unexpected notification read failure');
  return result.data;
}

describe('private medication recipients through the actual generator and SDK', () => {
  it('defers a managed child reminder when the child has no login, even with available managers', async () => {
    await generateFamilyNotifications(h.db!, FAMILY);
    expect(await unread('user-sibling')).toEqual([]);
    expect(h.calls.find(call => call.table === 'notifications' && call.query.includes('or='))?.query).toContain('user_id.is.null');
    expect(h.rows).toEqual([]);
    expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it.each(['missing member', 'empty roster'])('does not turn a %s into a family broadcast', async (state) => {
    h.members = state === 'missing member' ? h.members.filter(member => member.id !== med.member_id) : [];
    await generateFamilyNotifications(h.db!, FAMILY);
    expect(await unread('user-sibling')).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('keeps a linked child prescription private when the recipient roster read fails', async () => {
    h.members[3].user_id = 'user-target-child';
    h.failRoster = true;
    await expect(generateFamilyNotifications(h.db!, FAMILY)).rejects.toThrow(/roster/i);
    expect(h.calls.some(call => call.table === 'family_members')).toBe(true);
    expect(await unread('user-sibling')).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('can deliver privately on a later scan after recipient resolution recovers', async () => {
    h.members[3].user_id = 'user-target-child';
    h.failRoster = true;
    await expect(generateFamilyNotifications(h.db!, FAMILY)).rejects.toThrow(/roster/i);
    expect(h.rows).toEqual([]);
    expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
    h.failRoster = false;
    expect(await generateFamilyNotifications(h.db!, FAMILY)).toBe(1);
    expect(h.rows.map(row => row.user_id)).toEqual(['user-target-child']);
    expect(await unread('user-target-child')).toHaveLength(1);
    expect(await unread('user-sibling')).toEqual([]);
  });

  it('preserves the linked child recipient and excludes sibling and other-family readers', async () => {
    h.members[3].user_id = 'user-target-child';
    expect(await generateFamilyNotifications(h.db!, FAMILY)).toBe(1);
    expect(h.rows[0]).toMatchObject({ family_id: FAMILY, user_id: 'user-target-child', title: `Medication due: ${med.name}` });
    expect(h.rows[0].body).toContain(med.dosage);
    expect(await unread('user-target-child')).toHaveLength(1);
    expect(await unread('user-sibling')).toEqual([]);
    expect(await unread('user-target-child', 'family-B')).toEqual([]);
  });

  it('preserves the existing whole-family manager fanout', async () => {
    h.meds[0].member_id = null;
    expect(await generateFamilyNotifications(h.db!, FAMILY)).toBe(2);
    expect(h.rows.map(row => row.user_id).sort()).toEqual(['user-adult', 'user-parent']);
    expect(await unread('user-sibling')).toEqual([]);
    expect(await unread('user-parent')).toHaveLength(1);
  });

  it('does not remind about an inactive medication', async () => {
    h.members[3].user_id = 'user-target-child';
    h.meds[0].is_active = false;
    expect(await generateFamilyNotifications(h.db!, FAMILY)).toBe(0);
    expect(h.rows).toEqual([]);
  });

  it('does not remind about an already logged dose', async () => {
    h.members[3].user_id = 'user-target-child';
    h.doses = [{ schedule_id: schedule.id, scheduled_for: '2026-09-30T08:00:00.000Z', status: 'taken' }];
    expect(await generateFamilyNotifications(h.db!, FAMILY)).toBe(0);
    expect(h.rows).toEqual([]);
  });
});
