import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/**
 * The notification email digest (lib/server/notification-emails.ts) reads up to
 * 500 pending rows, sends one digest per recipient, and only THEN records
 * `sent_at` on every row it handled. Every READ in that file was chunked to keep
 * a PostgREST `.in()` filter inside the gateway's request line
 * (tests/an-in-filter-travels-in-the-url.test.ts), but the acknowledgement was
 * one `.update({ sent_at }).in('id', resolvedIds)` carrying every id at once.
 *
 * A filter travels in the URL at about 39 bytes per UUID, so once a day's batch
 * passed roughly 200 handled rows the acknowledgement was refused as too long
 * (500 ids is about 19.5 KB against an 8 KB request line). The digests had
 * already gone out, and nothing was stamped. The next daily run read the SAME
 * oldest 500 rows, sent every family the same digest again, failed the same
 * stamp again, and never reached a newer notification: the email channel
 * stalled for everyone, permanently, once the platform was busy enough.
 *
 * The transport below is the real supabase-js client over a fake fetch that
 * answers 414 to a request line longer than 8 KB, the nginx/Kong default.
 */

type Notice = { id: string; family_id: string; user_id: string; type: string; title: string; body: string; sent_at: string | null; send_at: string; created_at: string };
type Member = { id: string; family_id: string; user_id: string; role: string; is_active: boolean };

const h = vi.hoisted(() => ({
  notices: [] as Notice[],
  members: [] as Member[],
  users: [] as { id: string; email: string | null }[],
  sends: [] as { to: string; subject: string }[],
  acks: [] as string[][],
  refused: [] as { method: string; table: string; length: number }[],
}));

vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: h.users, error: null }),
}));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://synthetic.invalid',
  emailEnabled: () => true,
  sendReactEmail: async (input: { to: string; subject: string }) => {
    h.sends.push({ to: input.to, subject: input.subject });
    return { ok: true };
  },
}));
import { deliverNotificationEmails } from '@/lib/server/notification-emails';

/** nginx's default `large_client_header_buffers 4 8k`: the request line must fit 8 KB. */
const REQUEST_LINE_LIMIT = 8192;
/** The chunk size lib/supabase/chunked-in.ts and its URL ratchet hold every id list to. */
const CHUNK_LIMIT = 100;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAMILY = uuid(1);
const idsIn = (filter: string | null) => (filter?.startsWith('in.(') ? filter.slice(4, -1).split(',') : []);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function db(): SupabaseClient<Database> {
  return createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    accessToken: async () => null,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.origin !== 'https://synthetic.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport');
        const table = url.pathname.split('/').at(-1)!;
        const method = init?.method ?? 'GET';
        const q = url.searchParams;
        const requestLine = `${method} ${url.pathname}${url.search} HTTP/1.1`;
        if (requestLine.length > REQUEST_LINE_LIMIT) {
          h.refused.push({ method, table, length: requestLine.length });
          return new Response('414 Request-URI Too Large', { status: 414 });
        }
        const page = <T,>(rows: T[]) => {
          const offset = Number(q.get('offset') ?? 0);
          return rows.slice(offset, offset + Number(q.get('limit') ?? 1000));
        };

        if (table === 'notifications' && method === 'PATCH') {
          const patch = JSON.parse(String(init?.body));
          if (Object.keys(patch).join(',') !== 'sent_at') throw new Error('Unexpected acknowledgement');
          const ids = idsIn(q.get('id'));
          h.acks.push(ids);
          for (const n of h.notices) if (ids.includes(n.id)) n.sent_at = patch.sent_at;
          return new Response(null, { status: 204 });
        }
        if (method !== 'GET') throw new Error(`Unexpected ${method} on ${table}`);

        if (table === 'notifications') {
          const due = q.get('send_at')!.slice(4);
          return json(h.notices.filter((n) => n.sent_at === null && n.send_at <= due).slice(0, Number(q.get('limit') ?? 500))
            .map(({ id, family_id, user_id, type, title, body }) => ({ id, family_id, user_id, type, title, body })));
        }
        if (table === 'family_members') {
          const wanted = idsIn(q.get('user_id'));
          const rows = h.members
            .filter((m) => wanted.includes(m.user_id) && m.is_active && (q.get('role') !== 'eq.child' || m.role === 'child'))
            .sort((a, b) => a.id.localeCompare(b.id));
          return json(page(rows).map(({ id, user_id, family_id }) => ({ id, user_id, family_id })));
        }
        if (table === 'user_preferences' || table === 'family_ai_settings') return json([]);
        if (table === 'families') return json(idsIn(q.get('id')).map((id) => ({ id, timezone: 'UTC' })));
        throw new Error(`Unexpected table ${table}`);
      },
    },
  });
}

/** One family, `recipients` members, `perRecipient` pending notices each. */
function seed(recipients: number, perRecipient = 1) {
  let next = 10_000;
  for (let r = 0; r < recipients; r++) {
    const userId = uuid(1_000 + r);
    h.members.push({ id: uuid(5_000 + r), family_id: FAMILY, user_id: userId, role: 'parent', is_active: true });
    h.users.push({ id: userId, email: `member-${r}@synthetic.invalid` });
    for (let k = 0; k < perRecipient; k++) {
      const id = uuid(next++);
      h.notices.push({
        id, family_id: FAMILY, user_id: userId, type: 'system', title: `Synthetic notice ${id}`, body: 'Synthetic body',
        sent_at: null, send_at: '2026-01-01T00:00:00Z', created_at: `2026-01-01T00:00:${String(k % 60).padStart(2, '0')}Z`,
      });
    }
  }
}

beforeEach(() => {
  h.notices = []; h.members = []; h.users = []; h.sends = []; h.acks = []; h.refused = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a large notification email batch is stamped, and not sent again', () => {
  it('stamps every row of a 250-recipient day, so the next run sends nobody a second digest', async () => {
    seed(250);

    const first = await deliverNotificationEmails(db());
    const firstSends = h.sends.length;
    // The next day's run: nothing is pending, so nobody is emailed again.
    h.sends = [];
    const second = await deliverNotificationEmails(db());

    expect(h.sends.length, 'digests sent a second time by the next run').toBe(0);
    expect(first).toEqual({ sent: 250, failed: 0, skipped: 0 });
    expect(firstSends).toBe(250);
    expect(second).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(h.refused).toEqual([]);
    expect(h.notices.filter((n) => n.sent_at === null)).toEqual([]);
  });

  it('a full 500-row batch is acknowledged, and the newer notifications behind it are reached next', async () => {
    seed(600);

    expect(await deliverNotificationEmails(db())).toEqual({ sent: 500, failed: 0, skipped: 0 });
    expect(h.refused).toEqual([]);
    const firstRecipients = new Set(h.sends.map((s) => s.to));

    h.sends = [];
    expect(await deliverNotificationEmails(db())).toEqual({ sent: 100, failed: 0, skipped: 0 });
    // The second run reaches the 100 rows the first could not hold, not the first 500 again.
    expect(h.sends.filter((s) => firstRecipients.has(s.to))).toEqual([]);
    expect(h.notices.filter((n) => n.sent_at === null)).toEqual([]);
  });

  it('stamps one recipient whose own digest holds 300 rows', async () => {
    seed(1, 300);

    expect(await deliverNotificationEmails(db())).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.refused).toEqual([]);
    expect(h.notices.filter((n) => n.sent_at === null)).toEqual([]);
  });

  it('withheld rows of departed members are stamped in bounded requests too', async () => {
    seed(300);
    for (const m of h.members) m.is_active = false;

    expect(await deliverNotificationEmails(db())).toEqual({ sent: 0, failed: 0, skipped: 300 });
    expect(h.sends).toEqual([]);
    expect(h.refused).toEqual([]);
    expect(h.notices.filter((n) => n.sent_at === null)).toEqual([]);
  });

  it('every acknowledgement carries at most the chunk the repo holds an id list to', async () => {
    seed(250);
    await deliverNotificationEmails(db());

    expect(h.acks.length).toBeGreaterThan(1);
    expect(Math.max(...h.acks.map((ids) => ids.length))).toBeLessThanOrEqual(CHUNK_LIMIT);
    expect(new Set(h.acks.flat()).size).toBe(250);
  });

  it('calibration: the transport refuses a single acknowledgement of 250 ids', async () => {
    const response = await db().from('notifications').update({ sent_at: '2026-01-01T00:00:00Z' })
      .in('id', Array.from({ length: 250 }, (_, i) => uuid(20_000 + i)));
    expect(response.error).not.toBeNull();
    expect(h.refused).toHaveLength(1);
    // And a hundred fit with room to spare.
    h.refused = [];
    const fits = await db().from('notifications').update({ sent_at: '2026-01-01T00:00:00Z' })
      .in('id', Array.from({ length: CHUNK_LIMIT }, (_, i) => uuid(20_000 + i)));
    expect(fits.error).toBeNull();
    expect(h.refused).toEqual([]);
  });
});
