import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { ReactElement } from 'react';
import type { Database } from '@/lib/database.types';

type Member = { display_name: string; user_id: string | null; family_id?: string | null; is_active?: unknown };
type Assignment = {
  id: string; member_id: string; family_id: string; due_at: string | null; status: string;
  chores: { title: string; points: number } | null;
  family_members: Member | Member[] | null;
};
type EmailProps = { memberName: string; familyName: string; chores: { title: string; points: number; dueAt: string | null }[] };
type ChannelMember = { user_id: string; family_id: string; role: string; is_active: boolean };
type ChannelSetting = { family_id: string; child_channels: unknown };
const h = vi.hoisted(() => ({
  db: null as SupabaseClient<Database> | null,
  assignments: [] as Assignment[],
  families: [] as { id: string; name: string }[],
  users: [] as { id: string; email: string | null }[],
  channelMembers: [] as ChannelMember[],
  channelSettings: [] as ChannelSetting[],
  sends: [] as { to: string; props: EmailProps }[],
  calls: [] as { table: string; query: string }[],
  cap: 1000, failAssignmentOffset: null as number | null, failFamilies: false, failUsers: false,
  failChannelMembers: false, failChannelSettings: false,
  emailResult: { ok: true } as { ok: boolean; skipped?: boolean },
}));

// The GET, constant-time cron gate, actual SDK and paging helpers execute.
// Child-channel policy and helpers also execute. Account lookup and email
// transport are inert; no real Auth or mail is used.
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: h.users, error: h.failUsers ? { message: 'Synthetic account lookup failure' } : null }),
}));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async (input: { to: string; react: ReactElement<EmailProps> }) => {
    h.sends.push({ to: input.to, props: input.react.props });
    return h.emailResult;
  },
}));

import { GET } from '@/app/api/cron/chore-reminders/route';

const FAMILY = '00000000-0000-4000-8000-100000000001';
const FOREIGN = '00000000-0000-4000-8000-100000000002';
const NOW = '2026-10-02T12:00:00.000Z';
const SECRET = 'synthetic-chore-cron-only';
const member = (overrides: Partial<Member> = {}): Member => ({
  display_name: 'Synthetic member', user_id: 'synthetic-user', is_active: true, family_id: FAMILY, ...overrides,
});
const assignment = (id = 'assignment-1', overrides: Partial<Assignment> = {}): Assignment => ({
  id, member_id: 'synthetic-member', family_id: FAMILY, due_at: '2026-10-03T12:00:00Z', status: 'todo',
  chores: { title: `Synthetic chore ${id}`, points: 12 }, family_members: member(), ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.assignments = [assignment()];
  h.families = [{ id: FAMILY, name: 'Synthetic family' }, { id: FOREIGN, name: 'Synthetic other family' }];
  h.users = [{ id: 'synthetic-user', email: 'member@synthetic.invalid' }];
  h.channelMembers = []; h.channelSettings = [];
  h.sends = []; h.calls = []; h.cap = 1000; h.failAssignmentOffset = null; h.failFamilies = false; h.failUsers = false;
  h.emailResult = { ok: true };
  h.failChannelMembers = false; h.failChannelSettings = false;
  h.db = createClient<Database>('https://synthetic.invalid', 'synthetic-non-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://synthetic.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport origin');
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected mutation');
      const table = url.pathname.split('/').at(-1)!;
      const query = url.searchParams;
      h.calls.push({ table, query: url.search });
      const error = (message: string) => new Response(JSON.stringify({ code: '57014', message }), { status: 500, headers: { 'content-type': 'application/json' } });
      const channelPage = <T extends Record<string, unknown>>(rows: T[], order: keyof T) => {
        const paged = query.has('offset') || query.has('limit');
        if (paged && (!query.has('offset') || !query.has('limit') || query.get('order') !== `${String(order)}.asc`)) throw new Error('Unexpected child policy page');
        const ordered = paged ? [...rows].sort((a, b) => String(a[order]).localeCompare(String(b[order]))) : rows;
        const offset = Number(query.get('offset') ?? 0);
        return ordered.slice(offset, offset + Math.min(h.cap, Number(query.get('limit') ?? 1000)));
      };
      let data: unknown;
      if (table === 'chore_assignments') {
        const offset = Number(query.get('offset') ?? 0);
        if (offset === h.failAssignmentOffset) return error('Synthetic assignment read failure');
        const latest = query.getAll('due_at').find(filter => filter.startsWith('lte.'))?.slice(4);
        if (!latest || query.get('status') !== 'in.(todo,in_progress)' || !query.getAll('due_at').includes('not.is.null') || query.get('order') !== 'id.asc') throw new Error('Unexpected assignment filters');
        const selected = /family_members!member_id\(([^)]*)\)/.exec(query.get('select') ?? '')?.[1].split(',');
        if (!selected) throw new Error('Missing member projection');
        // Honor the actual SELECT. Returning unselected authorization columns
        // would let a broken query pass the membership tests accidentally.
        const project = (value: Member) => Object.fromEntries(selected.map(column => [column, value[column as keyof Member]]));
        data = h.assignments.filter(row => ['todo', 'in_progress'].includes(row.status) && row.due_at && row.due_at <= latest)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(offset, offset + Math.min(h.cap, Number(query.get('limit') ?? 1000)))
          .map(row => ({ ...row, family_members: Array.isArray(row.family_members) ? row.family_members.map(project) : row.family_members ? project(row.family_members) : null }));
      } else if (table === 'families') {
        if (h.failFamilies) return error('Synthetic family read failure');
        const ids = /^in\.\((.*)\)$/.exec(query.get('id') ?? '')?.[1].split(',');
        if (!ids) throw new Error('Unexpected family filter');
        data = h.families.filter(row => ids.includes(row.id));
      } else if (table === 'family_members') {
        if (h.failChannelMembers) return error('Synthetic child membership read failure');
        const users = /^in\.\((.*)\)$/.exec(query.get('user_id') ?? '')?.[1].split(',');
        if (!users || query.get('role') !== 'eq.child' || query.get('is_active') !== 'eq.true' || query.get('select') !== 'user_id,family_id') throw new Error('Unexpected child membership query');
        data = channelPage(h.channelMembers.map((row, index) => ({ ...row, id: `synthetic-member-${String(index).padStart(6, '0')}` }))
          .filter(row => users.includes(row.user_id) && row.role === 'child' && row.is_active), 'id')
          .map(row => ({ user_id: row.user_id, family_id: row.family_id }));
      } else if (table === 'family_ai_settings') {
        if (h.failChannelSettings) return error('Synthetic child settings read failure');
        const families = /^in\.\((.*)\)$/.exec(query.get('family_id') ?? '')?.[1].split(',');
        if (!families || query.get('select') !== 'family_id,child_channels') throw new Error('Unexpected child settings query');
        data = channelPage(h.channelSettings.filter(row => families.includes(row.family_id)), 'family_id')
          .map(row => ({ family_id: row.family_id, child_channels: row.child_channels }));
      } else throw new Error(`Unexpected table ${table}`);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function run(authorized = true) {
  const response = await GET(new NextRequest('https://synthetic.invalid/api/cron/chore-reminders', {
    headers: authorized ? { authorization: `Bearer ${SECRET}` } : {},
  }));
  return { status: response.status, body: await response.json() };
}

function expectOneChannelBatch(table: 'family_members' | 'family_ai_settings', ids: string[]) {
  const calls = h.calls.filter(call => call.table === table).map(call => new URLSearchParams(call.query));
  const column = table === 'family_members' ? 'user_id' : 'family_id';
  // Both helper revisions perform one logical ID batch here. A paged read
  // requests its one row and then an empty terminal page; an unpaged read is
  // exactly one request. Repeated batches must not pass either contract.
  expect(calls.map(query => query.get(column))).toEqual(calls[0].has('offset')
    ? [`in.(${ids.join(',')})`, `in.(${ids.join(',')})`]
    : [`in.(${ids.join(',')})`]);
  expect(calls.map(query => query.get('offset'))).toEqual(calls[0].has('offset') ? ['0', '1'] : [null]);
  expect(calls.map(query => query.get('limit'))).toEqual(calls[0].has('offset') ? ['1000', '1000'] : [null]);
}

describe('weekly chore reminder membership through the actual GET and SDK', () => {
  it.each([
    ['inactive', false], ['missing active state', undefined], ['null active state', null], ['malformed active state', 'true'],
  ])('does not email a recipient with %s membership', async (_label, active) => {
    h.assignments[0].family_members = member({ is_active: active });
    expect(await run()).toEqual({ status: 200, body: { sent: 0, message: 'No pending assignments' } });
    expect(h.sends).toEqual([]);
    expect(h.calls.every(call => call.table === 'chore_assignments')).toBe(true);
  });

  it.each([['foreign family', FOREIGN], ['missing family', undefined], ['null family', null]])('does not email a member from a %s', async (_label, familyId) => {
    h.assignments[0].family_members = member({ family_id: familyId });
    await run();
    expect(h.sends).toEqual([]);
  });

  it('does not email inactive members returned in an array embed', async () => {
    h.assignments[0].family_members = [member({ is_active: false })];
    await run();
    expect(h.sends).toEqual([]);
  });

  it('keeps the active recipient while excluding the inactive recipient in the same batch', async () => {
    h.assignments = [assignment('a-active'), assignment('b-inactive', { member_id: 'inactive-member', family_members: member({ is_active: false, user_id: 'inactive-user' }) })];
    h.users.push({ id: 'inactive-user', email: 'inactive@synthetic.invalid' });
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends.map(send => send.to)).toEqual(['member@synthetic.invalid']);
    expect(h.sends[0].props.chores.map(chore => chore.title)).toEqual(['Synthetic chore a-active']);
  });

  it('does not fold an assignment from another family into a valid member bucket', async () => {
    h.assignments = [assignment('a-active'), assignment('b-other-family', { family_id: FOREIGN })];
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends[0].props).toEqual({ memberName: 'Synthetic member', familyName: 'Synthetic family', chores: [{ title: 'Synthetic chore a-active', points: 12, dueAt: '2026-10-03T12:00:00Z' }] });
  });

  it('uses the accepted family name when a rejected foreign assignment sorts first', async () => {
    h.assignments = [assignment('a-foreign', { family_id: FOREIGN }), assignment('b-valid')];
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends[0].props.familyName).toBe('Synthetic family');
    expect(h.sends[0].props.chores.map(chore => chore.title)).toEqual(['Synthetic chore b-valid']);
    expect(h.calls.filter(call => call.table === 'families').map(call => new URLSearchParams(call.query).get('id'))).toEqual([`in.(${FAMILY})`]);
  });

  it('keeps membership checks across a capped, multi-page assignment read', async () => {
    h.cap = 1;
    h.assignments = [assignment('a-inactive', { family_members: member({ is_active: false }) }), assignment('b-active'), assignment('c-foreign', { family_members: member({ family_id: FOREIGN }) })];
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends[0].props.chores.map(chore => chore.title)).toEqual(['Synthetic chore b-active']);
    expect(h.calls.filter(call => call.table === 'chore_assignments').map(call => new URLSearchParams(call.query).get('offset'))).toEqual(['0', '1', '2', '3']);
  });

  it('can resume delivery on a later scan after the member becomes active', async () => {
    h.assignments[0].family_members = member({ is_active: false });
    await run();
    expect(h.sends).toEqual([]);
    h.assignments[0].family_members = member();
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends).toHaveLength(1);
  });

  it.each(['object', 'array'])('preserves an active linked recipient with an %s embed', async shape => {
    h.assignments[0].family_members = shape === 'array' ? [member()] : member();
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends).toEqual([{ to: 'member@synthetic.invalid', props: { memberName: 'Synthetic member', familyName: 'Synthetic family', chores: [{ title: 'Synthetic chore assignment-1', points: 12, dueAt: '2026-10-03T12:00:00Z' }] } }]);
  });

  it('preserves grouping multiple chores for the same current member into one email', async () => {
    h.assignments.push(assignment('assignment-2'));
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends[0].props.chores.map(chore => chore.title)).toEqual(['Synthetic chore assignment-1', 'Synthetic chore assignment-2']);
  });

  it.each([null, [], member({ user_id: null })])('does not email a missing or unlinked member (%j)', async embedded => {
    h.assignments[0].family_members = embedded;
    expect(await run()).toEqual({ status: 200, body: { sent: 0, message: 'No pending assignments' } });
    expect(h.sends).toEqual([]);
  });

  it('does not email a missing chore', async () => {
    h.assignments[0].chores = null;
    await run();
    expect(h.sends).toEqual([]);
  });

  it('preserves an empty successful scan', async () => {
    h.assignments = [];
    expect(await run()).toEqual({ status: 200, body: { sent: 0, message: 'No pending assignments' } });
    expect(h.sends).toEqual([]);
  });

  it('refuses a request without cron admission before reading assignments', async () => {
    expect(await run(false)).toEqual({ status: 401, body: { error: 'choreReminders.unauthorized' } });
    expect(h.calls).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it.each([0, 1])('refuses an assignment read failure at offset %i before sending a partial batch', async offset => {
    h.cap = 1; h.failAssignmentOffset = offset;
    h.assignments.push(assignment('assignment-2'));
    expect(await run()).toEqual({ status: 500, body: { error: 'choreReminders.choreReminderProcessingFailed' } });
    expect(h.sends).toEqual([]);
  });

  it('refuses a failed family-name lookup before sending', async () => {
    h.failFamilies = true;
    expect(await run()).toEqual({ status: 500, body: { error: 'choreReminders.choreReminderProcessingFailed' } });
    expect(h.sends).toEqual([]);
  });

  it('refuses a failed account lookup before sending', async () => {
    h.failUsers = true;
    expect(await run()).toEqual({ status: 500, body: { error: 'choreReminders.choreReminderProcessingFailed' } });
    expect(h.sends).toEqual([]);
  });

  it.each([
    { label: 'missing account', users: [] },
    { label: 'account without email', users: [{ id: 'synthetic-user', email: null }] },
  ])('reports an unreachable $label as skipped', async ({ users }) => {
    h.users = users;
    expect(await run()).toEqual({ status: 200, body: { sent: 0, failed: 0, skipped: 1 } });
    expect(h.sends).toEqual([]);
  });

  it('keeps a transport skip distinct from a send', async () => {
    h.emailResult = { ok: true, skipped: true };
    expect(await run()).toEqual({ status: 200, body: { sent: 0, failed: 0, skipped: 1 } });
  });

  it('reports a refused email transport as a failed run', async () => {
    h.emailResult = { ok: false };
    expect(await run()).toEqual({ status: 502, body: { sent: 0, failed: 1, skipped: 0 } });
  });

  it('withholds a weekly chore email when a child\'s family explicitly disables email', async () => {
    h.channelMembers = [{ user_id: 'synthetic-user', family_id: FAMILY, role: 'child', is_active: true }];
    h.channelSettings = [{ family_id: FAMILY, child_channels: { email: false, push: true } }];
    expect(await run()).toEqual({ status: 200, body: { sent: 0, failed: 0, skipped: 1 } });
    expect(h.sends).toEqual([]);
    expectOneChannelBatch('family_ai_settings', [FAMILY]);
  });

  it.each([
    { label: 'explicitly allowed child', role: 'child', active: true, setting: { email: true } },
    { label: 'child with absent channel', role: 'child', active: true, setting: {} },
    { label: 'child with absent settings', role: 'child', active: true, setting: undefined },
    { label: 'teen outside child policy', role: 'teen', active: true, setting: { email: false } },
    { label: 'parent outside child policy', role: 'parent', active: true, setting: { email: false } },
    { label: 'inactive child policy membership', role: 'child', active: false, setting: { email: false } },
  ])('preserves delivery to $label', async ({ role, active, setting }) => {
    h.channelMembers = [{ user_id: 'synthetic-user', family_id: FAMILY, role, is_active: active }];
    h.channelSettings = setting === undefined ? [] : [{ family_id: FAMILY, child_channels: setting }];
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 0 } });
    expect(h.sends).toHaveLength(1);
  });

  it('checks the whole recipient batch before sending and skips only blocked children', async () => {
    h.assignments.push(assignment('second-assignment', { member_id: 'other-member', family_members: member({ user_id: 'other-user' }) }));
    h.users.push({ id: 'other-user', email: 'other@synthetic.invalid' });
    h.channelMembers = [{ user_id: 'synthetic-user', family_id: FAMILY, role: 'child', is_active: true }];
    h.channelSettings = [{ family_id: FAMILY, child_channels: { email: false } }];
    expect(await run()).toEqual({ status: 200, body: { sent: 1, failed: 0, skipped: 1 } });
    expect(h.sends.map(send => send.to)).toEqual(['other@synthetic.invalid']);
    expectOneChannelBatch('family_members', ['synthetic-user', 'other-user']);
  });

  it.each(['members', 'settings'])('stops all sends when the child-channel %s read fails', async failure => {
    h.assignments.push(assignment('second-assignment', { member_id: 'other-member', family_members: member({ user_id: 'other-user' }) }));
    h.users.push({ id: 'other-user', email: 'other@synthetic.invalid' });
    h.channelMembers = [{ user_id: 'synthetic-user', family_id: FAMILY, role: 'child', is_active: true }];
    h.failChannelMembers = failure === 'members'; h.failChannelSettings = failure === 'settings';
    expect(await run()).toEqual({ status: 500, body: { error: 'choreReminders.choreReminderProcessingFailed' } });
    expect(h.sends).toEqual([]);
  });
});
