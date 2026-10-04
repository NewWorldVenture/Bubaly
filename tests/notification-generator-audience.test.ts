import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { generateFamilyNotifications } from '@/lib/server/notifications';

type Row = Record<string, unknown>;
type Read = { table: string; query: URLSearchParams; received: number };
const FAMILY = '00000000-0000-4000-8000-000000000001';
const OTHER_FAMILY = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TITLE = 'Synthetic private legal document';
const USER = id(90001);
let members: Row[], documents: Row[], events: Row[], reads: Read[], writes: Row[];
let cap: number, rosterFailureFrom: number | null, rosterFailure: 'error' | 'transport' | 'null' | 'object', documentFailure: boolean, writeFailure: boolean;

function member(n: number, role = 'child', userId: string | null = id(90000 + n)): Row {
  return { id: id(n), family_id: FAMILY, is_active: true, role, user_id: userId, display_name: 'Synthetic member', birthday: null };
}
beforeEach(() => {
  members = [member(10), member(999999, 'parent', USER)];
  documents = [{ id: id(10001), family_id: FAMILY, title: TITLE, is_secure: true, category: 'legal', expires_at: new Date(Date.now() + 86400000).toISOString() }];
  events = []; reads = []; writes = []; cap = Infinity; rosterFailureFrom = null;
  rosterFailure = 'error'; documentFailure = false; writeFailure = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// The SDK generates the real filters, projection, ordering and inclusive ranges.
// Only its transport is inert. All source/quiet-hours/notification builders run.
function db() {
  return createClient('https://synthetic.invalid', 'synthetic-only-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET', table = u.pathname.split('/').at(-1)!;
      if (u.origin !== 'https://synthetic.invalid') throw new Error('Unexpected transport host');
      if (method === 'POST' && table === 'notifications') {
        const payload: unknown = JSON.parse(String(init?.body));
        expect(Array.isArray(payload)).toBe(true);
        for (const row of payload as Row[]) { expect(row.family_id).toBe(FAMILY); writes.push(row); }
        return writeFailure
          ? json({ message: 'Synthetic notification refusal' }, 500)
          : new Response(null, { status: 201 });
      }
      if (method !== 'GET') throw new Error(`Unexpected SDK operation ${method}:${table}`);
      if (table === 'families') {
        expect(u.searchParams.get('id')).toBe(`eq.${FAMILY}`);
        return json([{ id: FAMILY, timezone: 'UTC' }]);
      }
      expect(u.searchParams.get('family_id'), `family filter for ${table}`).toBe(`eq.${FAMILY}`);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      if (table === 'family_members' && rosterFailureFrom !== null && offset >= rosterFailureFrom) {
        reads.push({ table, query: u.searchParams, received: 0 });
        if (rosterFailure === 'transport') throw new DOMException('Synthetic interrupted roster transport', 'AbortError');
        if (rosterFailure === 'null') return json(null);
        if (rosterFailure === 'object') return json({ unexpected: 'Synthetic malformed roster' });
        return json({ message: 'Synthetic roster unavailable' }, 500);
      }
      if (table === 'documents' && documentFailure) return json({ message: 'Synthetic document source refusal' }, 500);
      let rows = table === 'family_members' ? members : table === 'documents' ? documents : table === 'calendar_events' ? events : [];
      rows = rows.filter(r => r.family_id === FAMILY);
      if (table === 'family_members') {
        expect(u.searchParams.get('is_active')).toBe('eq.true');
        rows = rows.filter(r => r.is_active === true);
      }
      const ordering = u.searchParams.get('order');
      if (ordering) {
        const column = ordering.split('.')[0];
        rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
      }
      const limit = Number(u.searchParams.get('limit') ?? Infinity);
      rows = rows.slice(offset, offset + Math.min(limit, table === 'family_members' ? cap : Infinity));
      reads.push({ table, query: u.searchParams, received: rows.length });
      const columns = (u.searchParams.get('select') ?? '*').split(',');
      if (!columns.includes('*')) rows = rows.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null])));
      return json(rows);
    } },
  }) as never;
}
function json(value: unknown, status = 200) {
  // A collection carries the Content-Range PostgREST sends for an exact-count
  // request (`first-last/total`); the shared calendar read refuses an answer
  // without it. The rows here are the whole collection, so the total is theirs.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (Array.isArray(value) && status === 200) headers['content-range'] = value.length ? `0-${value.length - 1}/${value.length}` : '*/0';
  return new Response(JSON.stringify(value), { status, headers });
}
const generate = () => generateFamilyNotifications(db(), FAMILY);
const documentWrites = () => writes.filter(r => r.related_type === 'documents');
const rosterReads = () => reads.filter(r => r.table === 'family_members');

describe('document notifications use only verified account-backed managers', () => {
  it('targets the parent and preserves its member-specific dedupe identity', async () => {
    expect(await generate()).toBe(1);
    expect(documentWrites()).toMatchObject([{ user_id: USER, related_id: `${id(10001)}:${id(999999)}`, title: `Document expiring: ${TITLE}` }]);
  });
  it('targets each parent/adult separately while excluding child and teen accounts', async () => {
    members.push(member(15, 'adult', id(90002)), member(16, 'teen'));
    expect(await generate()).toBe(2); expect(documentWrites().map(r => r.user_id).sort()).toEqual([USER, id(90002)].sort());
  });
  it.each([null, '', '   '])('does not turn a manager account %j into a broadcast', async account => {
    members.push(member(15, 'adult', account));
    expect(await generate()).toBe(1); expect(documentWrites().map(r => r.user_id)).toEqual([USER]);
  });
  it('withholds document notices when the only manager has no account', async () => {
    members = [member(10), member(20, 'parent', null)];
    expect(await generate()).toBe(0); expect(writes).toEqual([]);
  });
  it('withholds document notices for a successfully read child-only roster', async () => {
    members = [member(10), member(11, 'teen')]; expect(await generate()).toBe(0); expect(writes).toEqual([]);
  });
  it('withholds document notices for a successfully read empty roster', async () => {
    members = []; expect(await generate()).toBe(0); expect(writes).toEqual([]);
  });
  it('excludes foreign and inactive managers without losing the active parent', async () => {
    members.push({ ...member(15, 'adult'), family_id: OTHER_FAMILY }, { ...member(16, 'adult'), is_active: false });
    expect(await generate()).toBe(1); expect(documentWrites().map(r => r.user_id)).toEqual([USER]);
  });
});

describe('audience resolution requires every ordered active roster page', () => {
  it.each([1, 7, 1000])('finds the parent beyond a server cap of %i', async serverCap => {
    cap = serverCap;
    members = [member(999999, 'parent', USER), ...Array.from({ length: serverCap }, (_, i) => member(100 + i))];
    expect(await generate()).toBe(1); expect(documentWrites().map(r => r.user_id)).toEqual([USER]);
    const pages = rosterReads();
    expect(pages.map(r => r.received)).toEqual([serverCap, 1, 0]);
    expect(pages.map(r => Number(r.query.get('offset')))).toEqual([0, serverCap, serverCap + 1]);
    for (const page of pages) {
      expect(page.query.get('order')).toBe('id.asc'); expect(page.query.get('limit')).toBe('1000');
      expect(page.query.get('select')).toBe('id,user_id,display_name,role,birthday');
    }
  });
  it('checks an empty terminal page after a short complete roster', async () => {
    expect(await generate()).toBe(1);
    expect(rosterReads().map(r => r.received)).toEqual([2, 0]);
  });
  it.each(['error', 'transport', 'null', 'object'] as const)('refuses all writes on first roster page %s', async mode => {
    rosterFailure = mode; rosterFailureFrom = 0;
    events = [{ id: id(20001), family_id: FAMILY, title: 'Synthetic family event', starts_at: new Date(Date.now() + 3600000).toISOString(), all_day: false, assignee_id: null, location: null }];
    await expect(generate()).rejects.toThrow(); expect(writes).toEqual([]);
  });
  it.each(['error', 'transport', 'null'] as const)('discards already resolved recipients when a later page has %s', async mode => {
    cap = 1; members = [member(10, 'parent', USER), member(20, 'adult', id(90002))];
    rosterFailure = mode; rosterFailureFrom = 1;
    await expect(generate()).rejects.toThrow(/roster/i); expect(writes).toEqual([]);
    expect(rosterReads().map(r => Number(r.query.get('offset')))).toEqual([0, 1]);
  });
});

describe('other source delivery behavior remains intact', () => {
  it('does not write when there are no source candidates', async () => {
    documents = []; expect(await generate()).toBe(0); expect(writes).toEqual([]);
  });
  it('degrades a failed document read while preserving a family-wide calendar notice', async () => {
    documentFailure = true;
    events = [{ id: id(20001), family_id: FAMILY, title: 'Synthetic family event', starts_at: new Date(Date.now() + 3600000).toISOString(), all_day: false, assignee_id: null, location: null }];
    expect(await generate()).toBe(1);
    expect(writes).toMatchObject([{ related_type: 'calendar_events', title: 'Synthetic family event', user_id: null }]);
    expect(console.error).toHaveBeenCalledWith('[notifications] generation source read failed', expect.objectContaining({ table: 'documents' }));
  });
  it('still reports a refused notification insert', async () => {
    writeFailure = true; await expect(generate()).rejects.toThrow('Synthetic notification refusal');
    expect(documentWrites().map(r => r.user_id)).toEqual([USER]);
  });
});
