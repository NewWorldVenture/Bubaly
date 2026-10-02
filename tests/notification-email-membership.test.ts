import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ReactElement } from 'react';
import type { Database } from '@/lib/database.types';

type Notice = { id: string; family_id: string; user_id: string | null; type: string; title: string; body: string; sent_at: string | null; send_at: string; created_at: string };
type Member = { id: string; family_id: string; user_id: string | null; role: string; is_active: boolean };
type Digest = { name: string; items: { title: string; body: string | null; icon: string }[] };
const h = vi.hoisted(() => ({
  notices: [] as Notice[], members: [] as Member[], prefs: [] as { user_id: string; email_enabled: boolean }[],
  settings: [] as { family_id: string; child_channels: Record<string, boolean> }[],
  users: [] as { id: string; email: string | null }[],
  sends: [] as { to: string; props: Digest; subject: string }[], ackIds: [] as string[],
  calls: [] as { table: string; method: string; query: string }[],
  cap: 1000, failRosterOffset: null as number | null, failTable: '', failAccounts: false, failResolve: false,
  emailConfigured: true, emailResult: { ok: true } as { ok: boolean; skipped?: boolean },
}));
// Actual delivery helper, grouping, consent reader, paging and SDK run. Account
// lookup and email transport are inert; this is not Auth/RLS/provider acceptance.
vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: h.users, error: h.failAccounts ? { message: 'Synthetic account failure' } : null }),
}));
vi.mock('@/lib/email', () => ({
  emailEnabled: () => h.emailConfigured,
  sendReactEmail: async (input: { to: string; subject: string; react: ReactElement<Digest> }) => {
    h.sends.push({ to: input.to, subject: input.subject, props: input.react.props });
    return h.emailResult;
  },
}));
import { deliverNotificationEmails } from '@/lib/server/notification-emails';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAMILY = uuid(1), OTHER = uuid(2), USER = uuid(100);
const ROLES = ['parent', 'adult', 'teen', 'child', 'grandparent', 'caregiver'];
const member = (overrides: Partial<Member> = {}): Member => ({ id: uuid(200), family_id: FAMILY, user_id: USER, role: 'parent', is_active: true, ...overrides });
const notice = (overrides: Partial<Notice> = {}): Notice => ({ id: uuid(300), family_id: FAMILY, user_id: USER, type: 'system', title: 'Synthetic household title', body: 'Synthetic household body', sent_at: null, send_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', ...overrides });
const idsIn = (filter: string | null) => filter?.startsWith('in.(') ? filter.slice(4, -1).split(',') : [];

function db(): SupabaseClient<Database> {
  return createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://synthetic.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport');
      const table = url.pathname.split('/').at(-1)!;
      const method = init?.method ?? 'GET', q = url.searchParams;
      h.calls.push({ table, method, query: url.search });
      const failure = () => new Response(JSON.stringify({ code: '57014', message: 'Synthetic query failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      if (h.failTable === table) return failure();
      if (table === 'notifications' && method === 'PATCH') {
        if (h.failResolve) return failure();
        const patch = JSON.parse(String(init?.body));
        if (Object.keys(patch).join(',') !== 'sent_at' || typeof patch.sent_at !== 'string') throw new Error('Unexpected acknowledgement');
        h.ackIds.push(...idsIn(q.get('id')));
        return new Response(null, { status: 204 });
      }
      if (method !== 'GET') throw new Error('Unexpected mutation');
      let rows: Record<string, unknown>[];
      if (table === 'notifications') {
        if (q.get('sent_at') !== 'is.null' || q.get('user_id') !== 'not.is.null' || !q.get('send_at')?.startsWith('lte.')) throw new Error('Unexpected pending filters');
        rows = h.notices.filter(n => n.sent_at === null && n.user_id !== null && n.send_at <= q.get('send_at')!.slice(4)).slice(0, Number(q.get('limit') ?? 500));
      } else if (table === 'family_members') {
        const offset = Number(q.get('offset') ?? 0), general = !q.has('role');
        if (general && offset === h.failRosterOffset) return failure();
        rows = h.members.filter(m => idsIn(q.get('user_id')).includes(m.user_id ?? '')
          && (q.get('is_active') !== 'eq.true' || m.is_active === true)
          && (q.get('role') !== 'eq.child' || m.role === 'child'));
        if (q.get('order') === 'id.asc') rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        rows = rows.slice(offset, offset + Math.min(Number(q.get('limit') ?? 1000), h.cap));
      } else if (table === 'user_preferences') {
        rows = h.prefs.filter(p => idsIn(q.get('user_id')).includes(p.user_id));
      } else if (table === 'family_ai_settings') {
        const paged = q.has('offset') || q.has('limit');
        if (paged && (!q.has('offset') || !q.has('limit') || q.get('order') !== 'family_id.asc')) throw new Error('Unexpected child settings page');
        rows = h.settings.filter(s => idsIn(q.get('family_id')).includes(s.family_id));
        if (q.get('order') === 'family_id.asc') rows.sort((a, b) => String(a.family_id).localeCompare(String(b.family_id)));
        const offset = Number(q.get('offset') ?? 0);
        rows = rows.slice(offset, offset + Math.min(Number(q.get('limit') ?? 1000), h.cap));
      } else throw new Error('Unexpected table');
      // Honor actual SELECT: unselected family metadata cannot accidentally
      // make a broken projection pass authorization or mixed-digest tests.
      const columns = q.get('select')?.split(',') ?? [];
      const data = rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
}

beforeEach(() => {
  h.notices = [notice()]; h.members = [member()]; h.prefs = []; h.settings = [];
  h.users = [{ id: USER, email: 'synthetic@synthetic.invalid' }];
  h.sends = []; h.ackIds = []; h.calls = []; h.cap = 1000; h.failRosterOffset = null; h.failTable = ''; h.failAccounts = false; h.failResolve = false;
  h.emailConfigured = true; h.emailResult = { ok: true };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const rosterCalls = () => h.calls.filter(c => c.table === 'family_members' && !new URLSearchParams(c.query).has('role'));

describe('queued notification emails require current membership in each family', () => {
  it.each(ROLES)('withholds a departed %s and settles the obsolete row', async role => {
    h.members = [member({ role, is_active: false })];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it.each(ROLES)('withholds a %s active only in another family', async role => {
    h.members = [member({ role, family_id: OTHER })];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it('withholds a recipient absent from the current roster', async () => {
    h.members = [];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it.each(ROLES)('preserves delivery for a current %s', async role => {
    h.members = [member({ role })];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends[0].props.items).toEqual([{ title: 'Synthetic household title', body: 'Synthetic household body', icon: '🔔' }]);
    expect(h.ackIds).toEqual([uuid(300)]);
  });
  it.each([false, true])('filters a mixed digest before grouping (foreign first=%s)', async reverse => {
    const foreign = notice({ id: uuid(301), family_id: OTHER, title: 'Synthetic foreign title', body: 'Synthetic foreign body' });
    h.notices = reverse ? [foreign, notice()] : [notice(), foreign];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends).toHaveLength(1); expect(h.sends[0].subject).toBe('1 family update · Bubaly');
    expect(h.sends[0].props.items).toEqual([{ title: 'Synthetic household title', body: 'Synthetic household body', icon: '🔔' }]);
    expect([...h.ackIds].sort()).toEqual([uuid(300), uuid(301)]);
  });
  it('preserves authorized updates from multiple current families in one digest', async () => {
    h.members.push(member({ id: uuid(201), family_id: OTHER }));
    h.notices.push(notice({ id: uuid(301), family_id: OTHER, title: 'Synthetic other current family' }));
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends[0].props.items.map(i => i.title)).toEqual(['Synthetic household title', 'Synthetic other current family']);
    expect(h.sends[0].subject).toBe('2 family updates · Bubaly');
  });
  it('completes a capped roster scan before accepting a later matching membership', async () => {
    h.cap = 1; h.members = [member({ family_id: OTHER }), member({ id: uuid(201) })];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(rosterCalls().map(c => Number(new URLSearchParams(c.query).get('offset')))).toEqual([0, 1, 2]);
    for (const call of rosterCalls()) expect(new URLSearchParams(call.query).get('order')).toBe('id.asc');
  });
  it.each([0, 1])('refuses a roster page failure at offset %i before all sends or acknowledgements', async offset => {
    h.cap = 1; h.members.push(member({ id: uuid(201), family_id: OTHER })); h.failRosterOffset = offset;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
  it('bounds roster ID batches and waits for a complete page of each batch', async () => {
    h.notices = []; h.members = []; h.users = [];
    for (let i = 0; i < 101; i++) {
      const user = uuid(1000 + i);
      h.notices.push(notice({ id: uuid(3000 + i), user_id: user }));
      h.members.push(member({ id: uuid(2000 + i), user_id: user }));
      h.users.push({ id: user, email: `synthetic-${i}@synthetic.invalid` });
    }
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 101, failed: 0, skipped: 0 });
    const initial = rosterCalls().filter(c => new URLSearchParams(c.query).get('offset') === '0');
    expect(initial.map(c => idsIn(new URLSearchParams(c.query).get('user_id')).length)).toEqual([100, 1]);
    expect(h.ackIds).toHaveLength(101);
  });
  it('retains explicit per-user and child-channel email refusals', async () => {
    h.members = [member({ role: 'child' })]; h.settings = [{ family_id: FAMILY, child_channels: { email: false } }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it('retains a recipient email opt-out', async () => {
    h.prefs = [{ user_id: USER, email_enabled: false }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it.each(['notifications', 'user_preferences'])('retains a %s read failure without acknowledgement', async table => {
    h.failTable = table;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
  it('retains an account lookup failure before delivery', async () => {
    h.failAccounts = true;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
  it('retains child-settings read refusal before delivery or acknowledgement', async () => {
    h.members = [member({ role: 'child' })]; h.failTable = 'family_ai_settings';
    await expect(deliverNotificationEmails(db())).rejects.toThrow('Child channel settings read failed.');
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
  it('keeps a failed authorized email pending but settles the withheld sibling row', async () => {
    h.notices.push(notice({ id: uuid(301), family_id: OTHER })); h.emailResult = { ok: false };
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(h.sends[0].props.items).toHaveLength(1); expect(h.ackIds).toEqual([uuid(301)]);
  });
  it('keeps an authorized digest pending when the transport reports no provider', async () => {
    h.emailResult = { ok: true, skipped: true };
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.ackIds).toEqual([]);
  });
  it('retains an acknowledgement failure as a failed run after a successful send', async () => {
    h.failResolve = true;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(h.sends).toHaveLength(1); expect(h.ackIds).toEqual([]);
  });
  it('retains missing-email settlement', async () => {
    h.users = [{ id: USER, email: null }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([uuid(300)]);
  });
  it('retains an unconfigured-provider no-op before all reads', async () => {
    h.emailConfigured = false;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(h.calls).toEqual([]); expect(h.sends).toEqual([]);
  });
  it('preserves an empty or broadcast-only queue without email', async () => {
    h.notices = [notice({ user_id: null })];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
});
