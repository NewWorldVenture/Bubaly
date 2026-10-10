import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { useFamilyClock, type FamilyClock } from '@/components/i18n/use-format';
import { localeOrDefault } from '@/lib/i18n/locales';
import { getMessages } from '@/lib/i18n/messages';
import { readAssistantRailCalendar as readRail } from '@/lib/calendar/assistant-rail';
const h = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/calendar/source-capability', () => ({
  get CALENDAR_SOURCE_ARCHIVE_ENABLED() {
    return h.enabled;
  },
}));
import { settleAll } from '@/lib/supabase/settle';
import { describeDbError } from '@/lib/supabase/errors';
import { orPredicate, type Row } from '@/tests/helpers/in-memory-supabase';
const file = new URL('../components/modules/assistant-module.tsx', import.meta.url);
const source = ts.createSourceFile(
  file.pathname,
  readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks: ts.ArrowFunction[] = [];
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'loadRail' &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  ) {
    const callback = node.initializer.arguments[0];
    if (ts.isArrowFunction(callback)) callbacks.push(callback);
  }
  ts.forEachChild(node, visit);
}
visit(source);
expect(callbacks).toHaveLength(1);
const callback = ts.transpileModule('const probe=' + callbacks[0].getText(source) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const FAMILY = '10000000-0000-4000-8000-000000000001';
const native = (n = 1, patch: Row = {}) => ({
  id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  family_id: FAMILY,
  title: 'Synthetic ' + n,
  starts_at: '2026-10-05T00:00:00.000Z',
  ends_at: patch.all_day === false ? null : '2026-10-06T00:00:00.000Z',
  all_day: true,
  recurrence: 'none',
  recurrence_until: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  category: 'general',
  description: null,
  location: null,
  assignee_id: null,
  feed_id: null,
  external_uid: null,
  onboarding_key: null,
  idempotency_key: null,
  created_by: null,
  source_recurrence: null,
  ...patch,
});
function clock(zone: string) {
  let result: FamilyClock | undefined;
  function Capture() {
    result = useFamilyClock();
    return null;
  }
  const props: Parameters<typeof LocaleProvider>[0] = {
    locale: localeOrDefault('en-US'),
    source: 'default',
    messages: getMessages('en-US'),
    timeZone: zone,
    children: createElement(Capture),
  };
  renderToStaticMarkup(createElement(LocaleProvider, props));
  return result!;
}
type Options = {
  cap?: number;
  count?: number;
  seriesCount?: number;
  error?: boolean;
  laterError?: boolean;
  defer?: Promise<void>;
  missingCount?: boolean;
  drift?: boolean;
  ignoreFamily?: boolean;
  respectAbort?: boolean;
  onFetch?: (url: URL, signal: AbortSignal | null | undefined) => void;
};
function setup(events: Row[], zone = 'America/New_York', options: Options = {}) {
  const calls: { url: URL; signal: AbortSignal | undefined | null }[] = [];
  const state: { glance: Row[]; upcoming: Row[]; activity: Row[]; error: unknown; loading: boolean } = {
    glance: [],
    upcoming: [],
    activity: [],
    error: null,
    loading: false,
  };
  const db = createClient('https://rail-loader.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://rail-loader.synthetic.invalid');
        expect(['GET', 'HEAD']).toContain(init?.method ?? 'GET');
        calls.push({ url, signal: init?.signal });
        options.onFetch?.(url, init?.signal);
        if (options.respectAbort && init?.signal?.aborted)
          throw new DOMException('Synthetic abort', 'AbortError');
        if (options.defer) await options.defer;
        if (options.error && url.pathname.endsWith('/calendar_events'))
          return Response.json({ message: 'Synthetic calendar refusal' }, { status: 403 });
        let rows = url.pathname.endsWith('/calendar_events') ? [...events] : [];
        for (const [key, value] of url.searchParams)
          if (
            !['select', 'order', 'offset', 'limit'].includes(key) &&
            !(key === 'family_id' && options.ignoreFamily)
          )
            rows = rows.filter(orPredicate(key === 'or' ? value.slice(1, -1) : key + '.' + value));
        rows.sort(
          (a, b) =>
            String(a.starts_at).localeCompare(String(b.starts_at)) ||
            String(a.id).localeCompare(String(b.id)),
        );
        const offset = Number(url.searchParams.get('offset') ?? 0),
          limit = Math.min(options.cap ?? 1000, Number(url.searchParams.get('limit') ?? 1000));
        if (offset && options.laterError)
          return Response.json({ message: 'Synthetic later-page refusal' }, { status: 403 });
        const page = rows.slice(offset, offset + limit),
          count = url.pathname.endsWith('/calendar_events')
            ? url.searchParams.get('recurrence') === 'neq.none'
              ? (options.seriesCount ?? options.count ?? rows.length)
              : (options.count ?? rows.length)
            : rows.length;
        return new Response(init?.method === 'HEAD' ? null : JSON.stringify(page), {
          headers: {
            'Content-Type': 'application/json',
            ...(options.missingCount
              ? {}
              : {
                  'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${count + (offset && options.drift ? 1 : 0)}`,
                }),
          },
        });
      },
    },
  });
  const mounted = { current: true },
    railRequest = { current: 0 },
    railAbort = { current: null as AbortController | null };
  const bindings = {
    readAssistantRailCalendar: readRail,
    family: { id: FAMILY },
    mounted,
    railRequest,
    railAbort,
    createClient: () => db,
    clock: clock(zone),
    setRailLoading: (v: boolean) => (state.loading = v),
    settleAll,
    setRailError: (v: unknown) => (state.error = v),
    describeDbError,
    t: (key: string) => key,
    setGlance: (v: Row[]) => (state.glance = v),
    setUpcoming: (v: Row[]) => (state.upcoming = v),
    setActivity: (v: Row[]) => (state.activity = v),
    fmtRelative: () => '',
    CalendarDays: () => null,
    CheckCircle2: () => null,
    Bell: () => null,
    Pill: () => null,
  };
  const load = new Function(...Object.keys(bindings), callback + 'return probe;')(
    ...Object.values(bindings),
  ) as () => Promise<void>;
  return { db, calls, state, load, mounted, railRequest, railAbort };
}
beforeEach(() => {
  h.enabled = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('ranks a Tokyo civil DATE before the next early timed starts before taking four', async () => {
  const date = native(1, { starts_at: '2026-10-06T00:00:00.000Z', ends_at: '2026-10-07T00:00:00.000Z' });
  const timed = [2, 3, 4, 5].map((n, i) =>
    native(n, { all_day: false, starts_at: `2026-10-05T${16 + i}:00:00.000Z` }),
  );
  const f = setup([date, ...timed], 'Asia/Tokyo', { cap: 2 });
  await f.load();
  expect(f.state.error).toBeNull();
  expect(f.state.upcoming.map((event) => event.id)).toEqual([date.id, timed[0].id, timed[1].id, timed[2].id]);
});
it('same-request abort with ignored transport publishes no late state', async () => {
  let release!: () => void;
  const f = setup([native()], 'UTC', {
    defer: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const loading = f.load();
  const request = f.railRequest.current;
  expect(f.state.loading).toBe(true);
  f.railAbort.current!.abort();
  release();
  await loading;
  expect(f.mounted.current).toBe(true);
  expect(f.railRequest.current).toBe(request);
  expect(f.state).toEqual({ glance: [], upcoming: [], activity: [], error: null, loading: true });
});
it('recurring presentation keys are stable across reloads while native IDs remain genuine', async () => {
  const master = native(1, {
    recurrence: 'daily',
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2026-10-02T00:00:00.000Z',
  });
  const f = setup([master]);
  await f.load();
  const keys = f.state.upcoming.map((event) => event.occurrenceKey);
  expect(new Set(keys).size).toBe(4);
  expect(f.state.upcoming.every((event) => event.id === master.id)).toBe(true);
  await f.load();
  expect(f.state.upcoming.map((event) => event.occurrenceKey)).toEqual(keys);
  expect(f.state.upcoming.every((event) => event.id === master.id)).toBe(true);
});
it.each(['UTC', 'Asia/Tokyo'])('healthy %s canonical todayDATE is counted', async (zone) => {
  const f = setup([native()], zone);
  await f.load();
  expect(f.state.glance[0].value).toBe('1');
  expect(f.state.error).toBeNull();
});
it('healthy NY timed actual today and tomorrow are read', async () => {
  const f = setup([
    native(1, { all_day: false, starts_at: '2026-10-05T14:00:00Z' }),
    native(2, { all_day: false, starts_at: '2026-10-06T14:00:00Z' }),
  ]);
  await f.load();
  expect(f.state.glance[0].value).toBe('1');
  expect(f.state.upcoming.map((e) => e.id)).toEqual([native(2).id]);
});
it('prototype NY canonical todayDATE must not be omitted', async () => {
  const f = setup([native()]);
  await f.load();
  expect(f.state.glance[0].value).toBe('1');
});
it('prototype NY tomorrowDATE must not be counted today', async () => {
  const f = setup([native(1, { starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' })]);
  await f.load();
  expect(f.state.glance[0].value).toBe('0');
});
it('prototype NY tomorrowDATE must appear in upcoming', async () => {
  const f = setup([native(1, { starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' })]);
  await f.load();
  expect(f.state.upcoming).toHaveLength(1);
});
it('prototype dailyseries master before window must produce today occurrence', async () => {
  const f = setup([
    native(1, {
      all_day: false,
      starts_at: '2026-10-01T14:00:00Z',
      ends_at: '2026-10-01T15:00:00Z',
      recurrence: 'daily',
    }),
  ]);
  await f.load();
  expect(f.state.glance[0].value).toBe('1');
});
it('prototype dailyseries master before window must produce four nearest upcoming occurrences', async () => {
  const f = setup([
    native(1, {
      all_day: false,
      starts_at: '2026-10-01T14:00:00Z',
      ends_at: '2026-10-01T15:00:00Z',
      recurrence: 'daily',
    }),
  ]);
  await f.load();
  expect(f.state.upcoming.map((e) => e.starts_at)).toEqual([
    '2026-10-06T14:00:00.000Z',
    '2026-10-07T14:00:00.000Z',
    '2026-10-08T14:00:00.000Z',
    '2026-10-09T14:00:00.000Z',
  ]);
});
it('prototype actual cap2 must not become confident2of3 todayevents', async () => {
  const f = setup(
    [1, 2, 3].map((n) => native(n, { all_day: false, starts_at: `2026-10-05T${10 + n}:00:00Z` })),
    'America/New_York',
    { cap: 2 },
  );
  await f.load();
  expect(f.state.glance[0].value).toBe('3');
});
it('prototype actual cap2 must load all nearest4 upcoming events', async () => {
  const f = setup(
    [1, 2, 3, 4].map((n) => native(n, { all_day: false, starts_at: `2026-10-0${5 + n}T14:00:00Z` })),
    'America/New_York',
    { cap: 2 },
  );
  await f.load();
  expect(f.state.upcoming).toHaveLength(4);
});
it('prototype later calendar page failure must remain an error rather than prefixcount', async () => {
  const f = setup(
    [1, 2, 3].map((n) => native(n, { all_day: false, starts_at: `2026-10-05T${10 + n}:00:00Z` })),
    'America/New_York',
    { cap: 2, laterError: true },
  );
  await f.load();
  expect(f.state.error).toBeTruthy();
});
it('healthy real SDK calendar error is surfaced without confidentcount', async () => {
  const f = setup([native()], 'UTC', { error: true });
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.glance).toHaveLength(0);
});
it('healthy disposal fence drops late fulfilled SDK responses', async () => {
  let release!: () => void;
  const f = setup([native()], 'UTC', { defer: new Promise<void>((r) => (release = r)) });
  const loading = f.load();
  f.mounted.current = false;
  f.railAbort.current?.abort();
  release();
  await loading;
  expect(f.state.glance).toHaveLength(0);
  expect(f.state.upcoming).toHaveLength(0);
  expect(f.calls.every((c) => c.signal?.aborted)).toBe(true);
});
it('healthy supersededrequest fence drops late fulfilled SDK responses', async () => {
  let release!: () => void;
  const f = setup([native()], 'UTC', { defer: new Promise<void>((r) => (release = r)) });
  const loading = f.load();
  f.railRequest.current++;
  release();
  await loading;
  expect(f.state.glance).toHaveLength(0);
  expect(f.state.upcoming).toHaveLength(0);
});

it('propagates the same actual SDK signal to both singles and series and every rebuilt page', async () => {
  const rows = [1, 2, 3].map((n) =>
    native(n, { all_day: false, starts_at: `2026-10-05T${10 + n}:00:00.000Z` }),
  );
  rows.push(
    ...[4, 5, 6].map((n) =>
      native(n, {
        all_day: false,
        starts_at: '2026-10-01T14:00:00.000Z',
        ends_at: null,
        recurrence: 'daily',
      }),
    ),
  );
  const f = setup(rows, 'America/New_York', { cap: 2 });
  await f.load();
  expect(f.state.error).toBeNull();
  expect(f.state.glance[0].value).toBe('6');
  const calls = f.calls.filter((c) => c.url.pathname.endsWith('/calendar_events'));
  expect(calls.every((c) => c.signal === f.railAbort.current!.signal)).toBe(true);
  expect(calls.filter((c) => c.url.searchParams.get('offset') === '2')).toHaveLength(2);
  expect(calls.some((c) => c.url.searchParams.get('recurrence') === 'neq.none')).toBe(true);
  expect(
    calls.some((c) => c.url.searchParams.getAll('or').includes('(recurrence.is.null,recurrence.eq.none)')),
  ).toBe(true);
});
it('actual SDK abort on a later page preserves an error rather than a partial success', async () => {
  let f: ReturnType<typeof setup>;
  f = setup(
    [1, 2, 3, 4, 5].map((n) => native(n)),
    'UTC',
    {
      cap: 2,
      respectAbort: true,
      onFetch: (url) => {
        if (url.searchParams.get('offset') === '2') f.railAbort.current?.abort();
      },
    },
  );
  await f.load();
  expect(f.state.error).toBeNull();
  expect(f.state.glance).toHaveLength(0);
  expect(f.calls.some((c) => c.url.searchParams.get('offset') === '2' && c.signal?.aborted)).toBe(true);
});
it('rejects an already aborted read before any calendar transport', async () => {
  const f = setup([native()]),
    abort = new AbortController();
  abort.abort();
  const c = clock('UTC'),
    now = new Date();
  const result = await readRail(
    f.db,
    FAMILY,
    'UTC',
    c.dayStart(0, now),
    c.dayStart(1, now),
    c.dayStart(14, now),
    abort.signal,
  );
  expect(result.error).toBeTruthy();
  expect(f.calls).toHaveLength(0);
});
it.each([{ missingCount: true }, { drift: true }])('refuses unqualified exact counts %j', async (options) => {
  const f = setup(
    [1, 2, 3, 4, 5].map((n) => native(n)),
    'UTC',
    { cap: 2, ...options },
  );
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.glance).toHaveLength(0);
});
it.each([
  { title: null },
  { created_at: undefined },
  { created_at: 'bad-clock' },
  { updated_at: undefined },
  { onboarding_key: undefined },
  { all_day: 'true' },
  { source_recurrence: { unsafe: true } },
  { id: 'invented' },
  { starts_at: '2026-10-05T03:00:00Z' },
  { ends_at: '2026-10-04T00:00:00Z' },
])('refuses malformed tail row201 before count/list %j', async (patch) => {
  const f = setup([...Array.from({ length: 200 }, (_, i) => native(i + 1)), native(201, patch)], 'UTC', {
    cap: 2,
  });
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.glance).toHaveLength(0);
  expect(f.state.upcoming).toHaveLength(0);
});
it('refuses a foreign-family response rather than adopt it', async () => {
  const f = setup([native(1, { family_id: '10000000-0000-4000-8000-000000000002' })], 'UTC', {
    ignoreFamily: true,
  });
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.glance).toHaveLength(0);
});
it('refuses source-enabled scope before native calendar reads', async () => {
  h.enabled = true;
  const f = setup([native()]);
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.calls.filter((c) => c.url.pathname.endsWith('/calendar_events'))).toHaveLength(0);
});
it('preserves day14 inclusive timed point and civil date, excluding the instant after it', async () => {
  const f = setup([
    native(1, { starts_at: '2026-10-06T00:00:00.000Z', ends_at: '2026-10-07T00:00:00.000Z' }),
    native(2, { starts_at: '2026-10-19T00:00:00.000Z', ends_at: '2026-10-20T00:00:00.000Z' }),
    native(3, { all_day: false, starts_at: '2026-10-19T04:00:00.000Z', ends_at: null }),
    native(4, { all_day: false, starts_at: '2026-10-19T04:00:00.001Z', ends_at: null }),
    native(5, { starts_at: '2026-10-20T00:00:00.000Z', ends_at: '2026-10-21T00:00:00.000Z' }),
  ]);
  await f.load();
  expect(f.state.error).toBeNull();
  expect(f.state.upcoming.map((e) => e.id)).toEqual([native(1).id, native(2).id, native(3).id]);
});
it('does not promote ongoing earlier starts and keeps original master creation clocks for activity', async () => {
  const f = setup([
    native(1, { starts_at: '2026-10-04T00:00:00.000Z', ends_at: '2026-10-07T00:00:00.000Z' }),
    native(2, {
      recurrence: 'daily',
      starts_at: '2026-10-01T00:00:00.000Z',
      ends_at: '2026-10-02T00:00:00.000Z',
    }),
  ]);
  await f.load();
  expect(f.state.glance[0].value).toBe('1');
  expect(f.state.activity).toHaveLength(1);
  expect(f.state.activity[0].text).toBe('assistantModule.addedToCalendar');
});
it.each(['2026-03-08T12:00:00Z', '2026-11-01T12:00:00Z'])(
  'respects actual NY DST family today %s',
  async (now) => {
    vi.setSystemTime(new Date(now));
    const day = now.slice(0, 10),
      next = day === '2026-03-08' ? '2026-03-09' : '2026-11-02';
    const f = setup([native(1, { starts_at: day + 'T00:00:00.000Z', ends_at: next + 'T00:00:00.000Z' })]);
    await f.load();
    expect(f.state.error).toBeNull();
    expect(f.state.glance[0].value).toBe('1');
  },
);
it('projects distinct stable UI keys for four dates of one recurring native event', async () => {
  const f = setup([
    native(1, {
      recurrence: 'daily',
      starts_at: '2026-10-01T00:00:00.000Z',
      ends_at: '2026-10-02T00:00:00.000Z',
    }),
  ]);
  await f.load();
  expect(f.state.upcoming).toHaveLength(4);
  expect(new Set(f.state.upcoming.map((e) => e.occurrenceKey)).size).toBe(4);
});
it.each([{ count: 20001 }, { seriesCount: 2001 }])(
  'refuses declared native collection overflow %j',
  async (options) => {
    const f = setup([native()], 'UTC', options);
    await f.load();
    expect(f.state.error).toBeTruthy();
    expect(f.state.glance).toHaveLength(0);
  },
);
it('refuses malformed upcoming row201 beyond the four-item cap', async () => {
  const rows = Array.from({ length: 201 }, (_, i) =>
    native(i + 1, {
      starts_at: '2026-10-06T00:00:00.000Z',
      ends_at: '2026-10-07T00:00:00.000Z',
      ...(i === 200 ? { title: null } : {}),
    }),
  );
  const f = setup(rows, 'UTC', { cap: 2 });
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.upcoming).toHaveLength(0);
});
it('retains actual original creation clocks for today recurring activity rows', async () => {
  const f = setup([
      native(1, {
        recurrence: 'daily',
        starts_at: '2026-10-01T00:00:00.000Z',
        ends_at: '2026-10-02T00:00:00.000Z',
      }),
    ]),
    c = clock('UTC'),
    now = new Date();
  const result = await readRail(
    f.db,
    FAMILY,
    'UTC',
    c.dayStart(0, now),
    c.dayStart(1, now),
    c.dayStart(14, now),
    new AbortController().signal,
  );
  expect(result.error).toBeNull();
  expect(result.data?.today[0].created_at).toBe('2026-10-01T00:00:00Z');
  expect(result.data?.today[0].id).toBe(native(1).id);
});
it('healthy admitted monthly master can yield no selected occurrences', async () => {
  const f = setup(
    [
      native(1, {
        recurrence: 'monthly',
        starts_at: '2026-09-25T00:00:00.000Z',
        ends_at: '2026-09-26T00:00:00.000Z',
      }),
    ],
    'UTC',
  );
  await f.load();
  expect(f.state.error).toBeNull();
  expect(f.state.glance[0].value).toBe('0');
  expect(f.state.upcoming).toHaveLength(0);
  expect(f.calls.some((c) => c.url.searchParams.get('recurrence') === 'neq.none')).toBe(true);
});
it.each([
  { title: null },
  { created_at: undefined },
  { feed_id: undefined },
  { family_id: '10000000-0000-4000-8000-000000000002' },
])('refuses malformed admitted master even when it emits zero occurrences %j', async (patch) => {
  const f = setup(
    [
      native(1, {
        recurrence: 'monthly',
        starts_at: '2026-09-25T00:00:00.000Z',
        ends_at: '2026-09-26T00:00:00.000Z',
        ...patch,
      }),
    ],
    'UTC',
    { ignoreFamily: true },
  );
  await f.load();
  expect(f.state.error).toBeTruthy();
  expect(f.state.glance).toHaveLength(0);
});
