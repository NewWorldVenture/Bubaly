import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';

// generateFamilyNotifications fans out ~13 parallel source reads. A swallowed read
// error would silently skip that whole notification category forever; it now logs
// each failed source read while still degrading (partial delivery > all-or-nothing).
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, neq: () => c, gte: () => c, lte: () => c, in: () => c,
    is: () => c, not: () => c, or: () => c, ilike: () => c, order: () => c, limit: () => c, range: () => c,
    maybeSingle: () => Promise.resolve(result),
    // A collection answer carries its count, as PostgREST's Content-Range does.
    then: (onF: (v: unknown) => unknown) => Promise.resolve(Array.isArray(result.data) ? { ...result, count: result.data.length } : result).then(onF),
  };
  return c;
}

// Every table read resolves empty/OK except the ones named in `errorTables`,
// which resolve with a PostgREST error. Inserts resolve OK.
function fakeSupabase(errorTables: Set<string>): SupabaseClient<Database> {
  return {
    from: (table: string) => ({
      ...chain(errorTables.has(table) ? { data: null, error: { message: `read failed: ${table}` } } : { data: [], error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
    }),
  } as unknown as SupabaseClient<Database>;
}

describe('generateFamilyNotifications source read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failed source read (by table name) and still returns without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set(['reminders', 'medications']));

    const created = await generateFamilyNotifications(supabase, 'fam-1');

    expect(created).toBe(0); // no candidates from empty sources — but it did not throw
    const logged = err.mock.calls.map((c) => `${c[0]} ${JSON.stringify(c[1])}`);
    expect(logged.some((l) => l.includes('generation source read failed') && l.includes('reminders'))).toBe(true);
    expect(logged.some((l) => l.includes('generation source read failed') && l.includes('medications'))).toBe(true);
  });

  it("throws when the family's timezone cannot be read, instead of falling back to UTC", async () => {
    // This one read is not like the other twelve, and the file says why at
    // length: `todayStartIso` bounds the doses already logged today, so read in
    // UTC the morning dose looks untaken every evening in California, and in
    // Tokyo yesterday's dose is mistaken for today's and the reminder NEVER
    // FIRES. A degraded category is a missing notification; a wrong day key is
    // a wrong one — and for medication, a missed one.
    //
    // So this read alone fails the family's whole tick. All three callers wrap
    // each family in try/catch and count `generationFailures`, so the family is
    // retried next tick and a broken tick still reads differently from a quiet
    // one.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set(['families']));

    await expect(generateFamilyNotifications(supabase, 'fam-1')).rejects.toThrow(/timezone/i);
  });

  it('refuses generation when the roster cannot establish recipients', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set(['family_members']));

    await expect(generateFamilyNotifications(supabase, 'fam-1')).rejects.toThrow(/roster/i);
  });

  it('a family row with no timezone set still uses the default, which is not the same thing', async () => {
    // Absent is not unreadable. Only a FAILED read is treated as unknown.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set());

    await expect(generateFamilyNotifications(supabase, 'fam-1')).resolves.toBe(0);
  });

  it('logs a failed conflict category independently so another sweep can retry it', async () => {
    const err=vi.spyOn(console,'error').mockImplementation(()=>{});
    await expect(generateFamilyNotifications(fakeSupabase(new Set(['calendar_events'])), 'fam-1')).resolves.toBe(0);
    expect(err).toHaveBeenCalledWith('[notifications] conflict read failed', expect.objectContaining({familyId:'fam-1'}));
    await expect(generateFamilyNotifications(fakeSupabase(new Set()), 'fam-1')).resolves.toBe(0);
  });

  it('does not log when all source reads succeed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set());

    await generateFamilyNotifications(supabase, 'fam-1');

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('generation source read failed'))).toBe(false);
  });
});

// The six historical read-boundary cases above use empty source answers. These
// controls exercise the installed SDK's actual projection, family filters and
// range queries with a private document and nonempty, server-capped rosters.
import { createClient } from '@supabase/supabase-js';
import { listUnread } from '@/lib/services/notifications';

type AudienceRow = Record<string, unknown>;
const AUDIENCE_FAMILY = '00000000-0000-4000-8000-000000000101';
const AUDIENCE_OTHER = '00000000-0000-4000-8000-000000000102';
const audienceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUDIENCE_PARENT = audienceId(900001);
const AUDIENCE_CHILD = audienceId(900002);
const AUDIENCE_ADULT = audienceId(900003);
const AUDIENCE_NOW = '2026-10-11T12:00:00.000Z';
const PRIVATE_DOCUMENT = 'Synthetic private legal title';

function audienceMember(n: number, role: string, user: string | null): AudienceRow {
  return { id: audienceId(n), family_id: AUDIENCE_FAMILY, is_active: true, role, user_id: user, display_name: 'Synthetic member', birthday: null };
}

function audienceTransport(options: {
  roster: AudienceRow[];
  cap?: number;
  failAt?: number;
  failure?: 'http' | 'transport' | 'null' | 'object';
  documentError?: boolean;
  publicEvent?: boolean;
}) {
  const pages: { offset: number; received: number; query: string }[] = [];
  const writes: AudienceRow[] = [];
  const operations: { method: string; table: string }[] = [];
  const emptySources = new Set([
    'chore_assignments', 'school_events', 'sports_events', 'reminders',
    'renewals', 'opportunities', 'medications', 'medication_schedules',
    'medication_doses', 'parent_approvals', 'relationship_dates',
    'family_reminders', 'family_photos', 'family_ai_settings',
  ]);
  const response = (data: unknown, status = 200, total?: number) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...(total === undefined ? {} : { 'content-range': `0-${Math.max(0, total - 1)}/${total}` }) },
  });
  const db = createClient<Database>('https://notification-audience.synthetic.invalid', 'synthetic-not-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://notification-audience.synthetic.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport destination');
      const table = url.pathname.split('/').at(-1)!;
      const method = init?.method ?? 'GET';
      operations.push({ method, table });
      if (method === 'POST' && table === 'notifications') {
        const payload: unknown = JSON.parse(String(init?.body));
        if (!Array.isArray(payload)) throw new Error('Expected notification batch');
        for (const row of payload as AudienceRow[]) {
          expect(row.family_id).toBe(AUDIENCE_FAMILY);
          writes.push({ ...row, id: audienceId(800000 + writes.length), created_at: AUDIENCE_NOW, is_read: false });
        }
        return new Response(null, { status: 201 });
      }
      if (method !== 'GET') throw new Error(`Unexpected operation ${method}:${table}`);
      if (table === 'families') {
        expect(url.searchParams.get('id')).toBe(`eq.${AUDIENCE_FAMILY}`);
        return response([{ id: AUDIENCE_FAMILY, timezone: 'UTC' }]);
      }
      const requestedFamily = url.searchParams.get('family_id');
      if (table !== 'notifications') expect(requestedFamily).toBe(`eq.${AUDIENCE_FAMILY}`);
      let rows: AudienceRow[] = [];
      if (table === 'family_members') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (options.failAt !== undefined && offset >= options.failAt) {
          pages.push({ offset, received: 0, query: url.search });
          if (options.failure === 'transport') throw new DOMException('Synthetic interrupted page', 'AbortError');
          if (options.failure === 'null') return response(null);
          if (options.failure === 'object') return response({ malformed: 'Synthetic roster' });
          return response({ message: 'Synthetic refused roster page' }, 500);
        }
        rows = options.roster.filter(row => requestedFamily === `eq.${row.family_id}`);
        if (url.searchParams.get('is_active') === 'eq.true') rows = rows.filter(row => row.is_active === true);
        if (url.searchParams.get('order') === 'id.asc') rows = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const limit = Number(url.searchParams.get('limit') ?? Infinity);
        rows = rows.slice(offset, offset + Math.min(limit, options.cap ?? Infinity));
        pages.push({ offset, received: rows.length, query: url.search });
      } else if (table === 'documents') {
        if (options.documentError) return response({ message: 'Synthetic document source refusal' }, 500);
        rows = [{ id: audienceId(200001), family_id: AUDIENCE_FAMILY, title: PRIVATE_DOCUMENT, category: 'legal', is_secure: true, expires_at: '2026-10-12' }];
      } else if (table === 'calendar_events' && options.publicEvent) {
        rows = [{ id: audienceId(200002), family_id: AUDIENCE_FAMILY, title: 'Synthetic public family event', starts_at: '2026-10-11T14:00:00.000Z', ends_at: '2026-10-11T15:00:00.000Z', all_day: false, assignee_id: null, location: null }];
      } else if (table === 'notifications') {
        rows = writes.filter(row => requestedFamily === `eq.${row.family_id}`);
        const audience = url.searchParams.get('or');
        if (audience) {
          const match = /^\(user_id\.eq\.([^,]+),user_id\.is\.null\)$/.exec(audience);
          if (!match) throw new Error('Unexpected notification audience query');
          rows = rows.filter(row => row.user_id === match[1] || row.user_id === null);
        } else {
          const related = url.searchParams.get('related_id');
          if (related?.startsWith('in.(')) rows = rows.filter(row => related.includes(String(row.related_id)));
        }
      } else if (table === 'calendar_events' || emptySources.has(table)) {
        // These named sources contain no rows in this finite household. A new
        // source table must be modeled explicitly rather than silently passing.
        rows = [];
      } else {
        throw new Error(`Unexpected source read: ${table}`);
      }
      const total = rows.length;
      const projection = (url.searchParams.get('select') ?? '*').split(',');
      if (!projection.includes('*')) rows = rows.map(row => Object.fromEntries(projection.map(column => [column, row[column] ?? null])));
      return response(rows, 200, total);
    } },
  });
  return { db, pages, writes, operations };
}

async function audienceUnread(db: SupabaseClient<Database>, user: string, family = AUDIENCE_FAMILY) {
  const result = await listUnread({ db, familyId: family, userId: user, memberId: audienceId(10), role: 'child', actorKind: 'member', tz: 'UTC', now: new Date(AUDIENCE_NOW) });
  if (!result.ok) throw new Error('Synthetic unread query refused');
  return result.data;
}

describe('generation establishes private audiences through complete SDK roster reads', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const start = (options: Parameters<typeof audienceTransport>[0]) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AUDIENCE_NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return audienceTransport(options);
  };

  it.each([1, 7, 1000])('finds a private parent beyond a nonempty server cap of %i', async cap => {
    const fixture = start({ cap, roster: [audienceMember(900000, 'parent', AUDIENCE_PARENT), ...Array.from({ length: cap }, (_, i) => audienceMember(10 + i, 'child', AUDIENCE_CHILD))] });
    expect(await generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).toBe(1);
    expect(fixture.pages.map(page => [page.offset, page.received])).toEqual([[0, cap], [cap, 1], [cap + 1, 0]]);
    for (const page of fixture.pages) {
      const query = new URLSearchParams(page.query);
      expect(query.get('order')).toBe('id.asc');
      expect(query.get('is_active')).toBe('eq.true');
      expect(query.get('limit')).toBe('1000');
    }
    expect(fixture.writes).toMatchObject([{ user_id: AUDIENCE_PARENT, related_id: `${audienceId(200001)}:${audienceId(900000)}`, title: `Document expiring: ${PRIVATE_DOCUMENT}` }]);
    expect(await audienceUnread(fixture.db, AUDIENCE_CHILD)).toEqual([]);
    expect(await audienceUnread(fixture.db, AUDIENCE_PARENT)).toHaveLength(1);
    expect(await audienceUnread(fixture.db, AUDIENCE_PARENT, AUDIENCE_OTHER)).toEqual([]);
  });

  it.each(['http', 'transport', 'null', 'object'] as const)('refuses both private and public writes after a first-page %s failure', async failure => {
    const fixture = start({ roster: [audienceMember(1, 'parent', AUDIENCE_PARENT)], failAt: 0, failure, publicEvent: true });
    await expect(generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).rejects.toThrow(/roster/i);
    expect(fixture.writes).toEqual([]);
    expect(fixture.operations.filter(operation => operation.method !== 'GET')).toEqual([]);
  });

  it.each(['http', 'transport', 'null', 'object'] as const)('discards a previously found parent when a later roster page has %s', async failure => {
    const fixture = start({ roster: [audienceMember(1, 'parent', AUDIENCE_PARENT), audienceMember(2, 'adult', AUDIENCE_ADULT)], cap: 1, failAt: 1, failure, publicEvent: true });
    await expect(generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).rejects.toThrow(/roster/i);
    expect(fixture.pages.map(page => page.offset)).toEqual([0, 1]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.operations.filter(operation => operation.method !== 'GET')).toEqual([]);
  });

  it('excludes foreign, inactive and accountless managers while both eligible managers receive private rows', async () => {
    const fixture = start({ cap: 1, roster: [
      audienceMember(1, 'parent', AUDIENCE_PARENT), audienceMember(2, 'adult', AUDIENCE_ADULT), audienceMember(3, 'child', AUDIENCE_CHILD),
      { ...audienceMember(4, 'parent', audienceId(900004)), family_id: AUDIENCE_OTHER }, { ...audienceMember(5, 'adult', audienceId(900005)), is_active: false },
      ...[null, '', '  '].map((account, i) => audienceMember(6 + i, 'adult', account)),
    ] });
    expect(await generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).toBe(2);
    expect(fixture.writes.map(row => row.user_id).sort()).toEqual([AUDIENCE_PARENT, AUDIENCE_ADULT].sort());
    expect(fixture.writes.every(row => row.user_id !== null)).toBe(true);
    expect(await audienceUnread(fixture.db, AUDIENCE_CHILD)).toEqual([]);
  });

  it.each(['empty', 'children only', 'accountless managers'] as const)('withholds sensitive documents for an entirely read %s roster while retaining public events', async state => {
    const roster = state === 'empty' ? [] : state === 'children only' ? [audienceMember(1, 'child', AUDIENCE_CHILD), audienceMember(2, 'teen', AUDIENCE_ADULT)] : [audienceMember(1, 'parent', null), audienceMember(2, 'adult', '')];
    const fixture = start({ roster, cap: 1, publicEvent: true });
    expect(await generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).toBe(1);
    expect(fixture.writes).toMatchObject([{ related_type: 'calendar_events', user_id: null, title: 'Synthetic public family event' }]);
    expect(fixture.writes.some(row => row.related_type === 'documents' || String(row.title).includes(PRIVATE_DOCUMENT))).toBe(false);
    expect((await audienceUnread(fixture.db, AUDIENCE_CHILD)).map(row => row.title)).toEqual(['Synthetic public family event']);
  });

  it('degrades a document read failure without losing an independently public event', async () => {
    const fixture = start({ roster: [audienceMember(1, 'parent', AUDIENCE_PARENT)], documentError: true, publicEvent: true });
    expect(await generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).toBe(1);
    expect(fixture.writes).toMatchObject([{ related_type: 'calendar_events', user_id: null }]);
    expect(console.error).toHaveBeenCalledWith('[notifications] generation source read failed', expect.objectContaining({ table: 'documents' }));
  });

  it('retries a refused later page from the beginning and only then writes the complete private audience', async () => {
    const options = { roster: [audienceMember(1, 'parent', AUDIENCE_PARENT), audienceMember(2, 'adult', AUDIENCE_ADULT)], cap: 1, failAt: 1 as number | undefined };
    const fixture = start(options);
    await expect(generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).rejects.toThrow(/roster/i);
    expect(fixture.writes).toEqual([]);
    options.failAt = undefined;
    expect(await generateFamilyNotifications(fixture.db, AUDIENCE_FAMILY)).toBe(2);
    expect(fixture.pages.map(page => [page.offset, page.received])).toEqual([[0, 1], [1, 0], [0, 1], [1, 1], [2, 0]]);
    expect(fixture.writes.map(row => row.user_id).sort()).toEqual([AUDIENCE_PARENT, AUDIENCE_ADULT].sort());
    expect(await audienceUnread(fixture.db, AUDIENCE_CHILD)).toEqual([]);
  });
});
