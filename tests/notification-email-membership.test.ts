import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@/lib/database.types';

type Notice = { id: string; family_id: string; user_id: string | null; type: string; title: string; body: string; sent_at: string | null; send_at: string; created_at: string };
type Member = { id: string; family_id: string; user_id: string | null; role: string; is_active: boolean };
type Digest = { name: string; items: { title: string; body: string | null; icon: string }[]; timeZone: string | null };
const h = vi.hoisted(() => ({
  notices: [] as Notice[], members: [] as Member[], prefs: [] as { user_id: string; email_enabled: boolean }[],
  settings: [] as { family_id: string; child_channels: Record<string, boolean> }[],
  families: [] as { id: string; timezone: string | null }[],
  users: [] as { id: string; email: string | null }[],
  sends: [] as { to: string; props: Digest; subject: string; react: ReactElement<Digest> }[], ackIds: [] as string[],
  calls: [] as { table: string; method: string; query: string }[],
  cap: 1000, failRosterOffset: null as number | null, failPrefsOffset: null as number | null,
  failTable: '', failAccounts: false, failResolve: false,
  emailConfigured: true, emailResult: { ok: true } as { ok: boolean; skipped?: boolean },
}));
// Actual delivery helper, grouping, consent reader, paging and SDK run. Account
// lookup and email transport are inert; this is not Auth/RLS/provider acceptance.
vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: h.users, error: h.failAccounts ? { message: 'Synthetic account failure' } : null }),
}));
vi.mock('@/lib/email', () => ({
  // The digest template links back to the app; the two-family cases render it.
  APP_URL: 'https://synthetic.invalid',
  emailEnabled: () => h.emailConfigured,
  sendReactEmail: async (input: { to: string; subject: string; react: ReactElement<Digest> }) => {
    h.sends.push({ to: input.to, subject: input.subject, props: input.react.props, react: input.react });
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
  return createClient<Database>('https://synthetic.invalid', 'synthetic-key', {accessToken:async()=>null,
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
        const offset = Number(q.get('offset') ?? 0);
        if (offset === h.failPrefsOffset) return failure();
        const paged = q.has('offset') || q.has('limit');
        if (paged && (!q.has('offset') || !q.has('limit') || q.get('order') !== 'user_id.asc')) throw new Error('Unexpected preference page');
        rows = h.prefs.filter(p => idsIn(q.get('user_id')).includes(p.user_id));
        if (q.get('order') === 'user_id.asc') rows.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
        rows = rows.slice(offset, offset + Math.min(Number(q.get('limit') ?? 1000), h.cap));
      } else if (table === 'family_ai_settings') {
        const paged = q.has('offset') || q.has('limit');
        if (paged && (!q.has('offset') || !q.has('limit') || q.get('order') !== 'family_id.asc')) throw new Error('Unexpected child settings page');
        rows = h.settings.filter(s => idsIn(q.get('family_id')).includes(s.family_id));
        if (q.get('order') === 'family_id.asc') rows.sort((a, b) => String(a.family_id).localeCompare(String(b.family_id)));
        const offset = Number(q.get('offset') ?? 0);
        rows = rows.slice(offset, offset + Math.min(Number(q.get('limit') ?? 1000), h.cap));
      } else if (table === 'families') {
        // The digest's date line reads each family's zone (#942). An absent row
        // dates that family's digest in an explicit UTC.
        rows = h.families.filter(f => idsIn(q.get('id')).includes(f.id));
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
  h.notices = [notice()]; h.members = [member()]; h.prefs = []; h.settings = []; h.families = [];
  h.users = [{ id: USER, email: 'synthetic@synthetic.invalid' }];
  h.sends = []; h.ackIds = []; h.calls = []; h.cap = 1000; h.failRosterOffset = null; h.failPrefsOffset = null; h.failTable = ''; h.failAccounts = false; h.failResolve = false;
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

describe('queued email preference preflight under configured small response caps', () => {
  function secondAdult() {
    h.notices.push(notice({ id: uuid(301), user_id: uuid(101), title: 'Synthetic second adult title' }));
    h.members.push(member({ id: uuid(201), user_id: uuid(101), role: 'adult' }));
    h.users.push({ id: uuid(101), email: 'second-adult@synthetic.invalid' });
    h.prefs = [{ user_id: USER, email_enabled: true }, { user_id: uuid(101), email_enabled: false }];
    h.cap = 1;
  }
  it('preserves a second adult opt-out after a one-row preference response cap', async () => {
    secondAdult();
    const result = await deliverNotificationEmails(db());
    expect(h.sends.map(send => send.to)).toEqual(['synthetic@synthetic.invalid']);
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect([...h.ackIds].sort()).toEqual([uuid(300), uuid(301)]);
  });
  it('does not send or acknowledge any row after a later preference page fails', async () => {
    secondAdult(); h.failPrefsOffset = 1; h.notices.push(notice({ id: uuid(302), family_id: OTHER, title: 'Synthetic withheld family update' }));
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toEqual([]);
  });
  it('preserves delivery to both opted-in adults under the same cap', async () => {
    secondAdult(); h.prefs[1].email_enabled = true;
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(h.sends.map(send => send.to)).toEqual(['synthetic@synthetic.invalid', 'second-adult@synthetic.invalid']);
    expect([...h.ackIds].sort()).toEqual([uuid(300), uuid(301)]);
  });
});

describe('queued email preference completeness controls', () => {
  it('preserves the ordinary-cap opt-out without implying a default-cap defect', async () => {
    h.notices.push(notice({ id: uuid(301), user_id: uuid(101) }));
    h.members.push(member({ id: uuid(201), user_id: uuid(101), role: 'adult' }));
    h.users.push({ id: uuid(101), email: 'second-adult@synthetic.invalid' });
    h.prefs = [{ user_id: USER, email_enabled: true }, { user_id: uuid(101), email_enabled: false }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(h.sends.map(s => s.to)).toEqual(['synthetic@synthetic.invalid']);
    expect([...h.ackIds].sort()).toEqual([uuid(300), uuid(301)]);
  });
  it('keeps missing preference rows allowed after a capped read reaches its empty end page', async () => {
    h.cap = 1; h.prefs = [];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends.map(s => s.to)).toEqual(['synthetic@synthetic.invalid']);
    expect(h.ackIds).toEqual([uuid(300)]);
  });
  it('bounds preference IDs and retrieves all false settings across a capped 101-recipient batch', async () => {
    h.notices = []; h.members = []; h.users = []; h.prefs = []; h.cap = 40;
    for (let i = 0; i < 101; i++) {
      const user = uuid(1000 + i);
      h.notices.push(notice({ id: uuid(3000 + i), user_id: user }));
      h.members.push(member({ id: uuid(2000 + i), user_id: user }));
      h.users.push({ id: user, email: `adult-${i}@synthetic.invalid` });
      h.prefs.push({ user_id: user, email_enabled: false });
    }
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 101 });
    expect(h.sends).toEqual([]); expect(h.ackIds).toHaveLength(101);
    const calls = h.calls.filter(c => c.table === 'user_preferences');
    expect(calls.filter(c => new URLSearchParams(c.query).get('offset') === '0').map(c => idsIn(new URLSearchParams(c.query).get('user_id')).length)).toEqual([100, 1]);
    expect(calls.filter(c => idsIn(new URLSearchParams(c.query).get('user_id')).length === 100).map(c => new URLSearchParams(c.query).get('offset'))).toEqual(['0', '40', '80', '100']);
  });
});

// A user can belong to several families, and one digest holds all of their
// permitted rows. Its date line is a FAMILY's day, so it was wrong whenever the
// families kept different zones: the sender dated the whole digest in the
// first row's family's zone, and the other family's rows could carry the wrong
// calendar day (review finding on #942). Saturday 3 October, 5:30pm in Los
// Angeles is already Sunday 4 October in Kiritimati.
describe('a recipient in two families gets one digest, dated in no single family\'s zone', () => {
  const LA = 'America/Los_Angeles', KIRITIMATI = 'Pacific/Kiritimati';
  const render = (el: ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-04T00:30:00.000Z');
    h.members = [member({ id: uuid(200), family_id: FAMILY }), member({ id: uuid(201), family_id: OTHER })];
    h.notices = [notice({ id: uuid(300), family_id: FAMILY }), notice({ id: uuid(301), family_id: OTHER })];
  });
  afterEach(() => vi.useRealTimers());

  it('two families in different zones: one digest, settled once, with no date line at all', async () => {
    h.families = [{ id: FAMILY, timezone: LA }, { id: OTHER, timezone: KIRITIMATI }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends.map(s => s.to)).toEqual(['synthetic@synthetic.invalid']);
    expect(h.sends[0].props.timeZone).toBeNull();
    const html = render(h.sends[0].react);
    expect(html).not.toContain('October 3'); // Los Angeles's day — the first row's family
    expect(html).not.toContain('October 4'); // Kiritimati's, and Greenwich's
    expect(html).toContain("here's what's coming up.");
    expect(html).toContain('Synthetic household title');
    expect([...h.ackIds].sort()).toEqual([uuid(300), uuid(301)]);
  });
  it('the order of the rows does not pick the zone', async () => {
    h.notices.reverse();
    h.families = [{ id: FAMILY, timezone: LA }, { id: OTHER, timezone: KIRITIMATI }];
    await deliverNotificationEmails(db());
    expect(h.sends[0].props.timeZone).toBeNull();
  });
  it('two families in the same zone: dated in it', async () => {
    h.families = [{ id: FAMILY, timezone: LA }, { id: OTHER, timezone: LA }];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends[0].props.timeZone).toBe(LA);
    expect(render(h.sends[0].react)).toContain('Saturday, October 3');
  });
  it("one family: dated in its own, and a zone the batch could not read is an explicit UTC", async () => {
    h.notices = [notice({ id: uuid(300), family_id: FAMILY })];
    h.families = [{ id: FAMILY, timezone: KIRITIMATI }];
    await deliverNotificationEmails(db());
    expect(h.sends[0].props.timeZone).toBe(KIRITIMATI);
    expect(render(h.sends[0].react)).toContain('Sunday, October 4');
    h.sends = []; h.ackIds = []; h.notices = [notice({ id: uuid(300), family_id: FAMILY })]; h.families = [];
    await deliverNotificationEmails(db());
    expect(h.sends[0].props.timeZone).toBe('UTC');
  });
});
