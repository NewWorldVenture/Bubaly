import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { ComponentProps } from 'react';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';
import { orPredicate, type Row } from '@/tests/helpers/in-memory-supabase';
import { at } from '@/tests/helpers/source-order';
const h = vi.hoisted(() => ({ db: null as SupabaseClient<Database> | null, enabled: false }));
vi.mock('@/lib/calendar/source-capability', () => ({
  get CALENDAR_SOURCE_ARCHIVE_ENABLED() {
    return h.enabled;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
    translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) =>
    createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';
const FAMILY = '10000000-0000-4000-8000-000000000001';
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
function comparableClock(value: unknown): unknown {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : value;
}
function event(n = 1, patch: Row = {}) {
  return {
    id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    family_id: FAMILY,
    title: `Synthetic ${n}`,
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
  };
}
async function render(
  rows: Row[],
  zone = 'America/New_York',
  options: {
    cap?: number;
    error?: boolean;
    laterError?: boolean;
    missingCount?: boolean;
    drift?: boolean;
    count?: number;
    ignoreFamily?: boolean;
  } = {},
) {
  const calls: URL[] = [];
  h.db = createClient<Database>('https://family-dashboard.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const u = new URL(String(input));
        expect(u.origin).toBe('https://family-dashboard.synthetic.invalid');
        expect(['GET', 'HEAD']).toContain(init?.method ?? 'GET');
        calls.push(u);
        if (!u.pathname.endsWith('/calendar_events'))
          return new Response(init?.method === 'HEAD' ? null : '[]', {
            headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
          });
        if (options.error && u.pathname.endsWith('/calendar_events'))
          return Response.json({ message: 'Synthetic refusal' }, { status: 403 });
        let values = u.pathname.endsWith('/calendar_events') ? [...rows] : [];
        for (const [key, value] of u.searchParams) {
          if (
            !['select', 'order', 'offset', 'limit'].includes(key) &&
            !(key === 'family_id' && options.ignoreFamily)
          ) {
            // PostgreSQL compares timestamptz values as instants, including
            // equivalent Z/offset and fractional-second representations.
            const filter = (key === 'or' ? value.slice(1, -1) : key + '.' + value).replace(
              timestampPattern,
              (clock) => String(comparableClock(clock)),
            );
            const predicate = orPredicate(filter);
            values = values.filter((row) =>
              predicate({
                ...row,
                starts_at: comparableClock(row.starts_at),
                ends_at: comparableClock(row.ends_at),
                recurrence_until: comparableClock(row.recurrence_until),
              }),
            );
          }
        }
        values.sort(
          (a, b) =>
            Date.parse(String(a.starts_at)) - Date.parse(String(b.starts_at)) ||
            String(a.id).localeCompare(String(b.id)),
        );
        const offset = Number(u.searchParams.get('offset') ?? 0),
          limit = Math.min(options.cap ?? 1000, Number(u.searchParams.get('limit') ?? 1000));
        if (offset && options.laterError)
          return Response.json({ message: 'Synthetic later refusal' }, { status: 403 });
        const page = values.slice(offset, offset + limit);
        return new Response(init?.method === 'HEAD' ? null : JSON.stringify(page), {
          headers: {
            'Content-Type': 'application/json',
            ...(options.missingCount
              ? {}
              : {
                  'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${(options.count ?? values.length) + (offset && options.drift ? 1 : 0)}`,
                }),
          },
        });
      },
    },
  });
  const ctx = {
    user: { id: '30000000-0000-4000-8000-000000000001', email: null },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, timezone: zone },
      role: 'parent',
      member: {
        id: '20000000-0000-4000-8000-000000000001',
        user_id: '30000000-0000-4000-8000-000000000001',
        display_name: 'Synthetic',
      },
    },
  };
  // Only the caller identity and family/member fields consumed by this surface
  // are projected here; no Auth/session acceptance is inferred from this fixture.
  const element = await FamilyDashboard({ ctx: ctx as unknown as UserContext });
  const html = renderToStaticMarkup(element);
  return {
    html,
    calls,
    element,
    count: Number(html.match(/text-2xl font-bold leading-none">(\d+)<\/p>/)![1]),
  };
}
function nativeKeys(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(nativeKeys);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    ...(typeof node.key === 'string' && node.key.startsWith('["native",') ? [node.key] : []),
    ...nativeKeys(node.props.children),
  ];
}
function expectUnavailable(html: string) {
  expect(html).toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
  expect(html).toContain(translate(getMessages('en-US'), 'homeCalendar.upcomingUnavailable'));
  expect(html).not.toContain(translate(getMessages('en-US'), 'familyDashboard.nothingScheduledToday'));
  expect(html).not.toContain(translate(getMessages('en-US'), 'familyDashboard.noUpcomingEvents'));
  expect(html).not.toContain(translate(getMessages('en-US'), 'familyDashboard.allOnTrack'));
  expect(html).not.toMatch(/text-2xl font-bold leading-none">\d+<\/p><p class="mt-0.5 text-xs text-muted">Events Today/);
}
beforeEach(() => {
  h.enabled = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
it.each(['UTC', 'Asia/Tokyo'])('healthy %s DATE today', async (zone) => {
  expect((await render([event()], zone)).count).toBe(1);
});
it('healthy timed NY event remains today', async () => {
  expect((await render([event(1, { all_day: false, starts_at: '2026-10-05T14:00:00Z' })])).count).toBe(1);
});
it('healthy foreign family is excluded', async () => {
  expect((await render([event(1, { family_id: '10000000-0000-4000-8000-000000000002' })])).count).toBe(0);
});
it('NY canonical todayDATE must be counted', async () => {
  expect((await render([event()])).count).toBe(1);
});
it('NY tomorrowDATE must not be counted today', async () => {
  expect(
    (await render([event(1, { starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' })])).count,
  ).toBe(0);
});
it('NY tomorrowDATE must appear in upcoming', async () => {
  const r = await render([
    event(1, { title: 'Tomorrow civil', starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' }),
  ]);
  const upcoming = r.html
    .split('<h2 class="font-semibold">Upcoming Events</h2>')[1]
    ?.split('AI Assistant')[0];
  expect(upcoming).toContain('Tomorrow civil');
});
it('NY later upcomingDATE badge must retain civil day7', async () => {
  const r = await render([
    event(1, { title: 'Later civil', starts_at: '2026-10-07T00:00:00Z', ends_at: '2026-10-08T00:00:00Z' }),
  ]);
  expect(r.html).toContain('Later civil');
  expect(r.html).toContain('text-base font-black leading-none">7</p>');
});
it('daily recurring master before window must appear today', async () => {
  expect(
    (
      await render([
        event(1, { recurrence: 'daily', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-02T00:00:00Z' }),
      ])
    ).count,
  ).toBe(1);
});
it('cap2 must not become confident2of3 Events Today', async () => {
  const r = await render(
    [1, 2, 3].map((n) => event(n, { all_day: false, starts_at: `2026-10-05T${10 + n}:00:00Z` })),
    'UTC',
    { cap: 2 },
  );
  expect(r.count).toBe(3);
});
it('presentation8 must not become falsely complete8of9 Events Today', async () => {
  expect(
    (
      await render(
        Array.from({ length: 9 }, (_, i) => event(i + 1)),
        'UTC',
      )
    ).count,
  ).toBe(9);
});
it('calendar failure must not render Nothing scheduled today as a known empty day', async () => {
  const r = await render([event()], 'UTC', { error: true });
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'familyDashboard.nothingScheduledToday'));
});
it.each(['2026-03-08T12:00:00Z', '2026-11-01T12:00:00Z'])('NY DST civil today %s', async (now) => {
  vi.setSystemTime(new Date(now));
  const day = now.slice(0, 10),
    end = day === '2026-03-08' ? '2026-03-09' : '2026-11-02';
  expect(
    (await render([event(1, { starts_at: day + 'T00:00:00Z', ends_at: end + 'T00:00:00Z' })])).count,
  ).toBe(1);
});
it('healthy empty calendar retains genuine empty messages', async () => {
  const r = await render([]);
  expect(r.count).toBe(0);
  expect(r.html).toContain(translate(getMessages('en-US'), 'familyDashboard.nothingScheduledToday'));
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
});
it('source-enabled calendar stays held before calendar transport', async () => {
  h.enabled = true;
  const r = await render([event()]);
  expectUnavailable(r.html);
  expect(r.calls.filter((u) => u.pathname.endsWith('/calendar_events'))).toHaveLength(0);
});
it.each([{ laterError: true }, { missingCount: true }, { drift: true }, { count: 20001 }])(
  'incomplete calendar refuses both panels and confident counts %j',
  async (options) => {
    const r = await render(
      [1, 2, 3].map((n) => event(n)),
      'UTC',
      { cap: 2, ...options },
    );
    expectUnavailable(r.html);
  },
);
it.each([
  { title: null },
  { created_at: undefined },
  { updated_at: 'bad-clock' },
  { feed_id: undefined },
  { source_recurrence: { unsafe: true } },
  { starts_at: '2026-10-05T03:00:00Z' },
])('malformed row201 refuses before presentation %j', async (patch) => {
  const rows = Array.from({ length: 201 }, (_, i) => event(i + 1, i === 200 ? patch : {}));
  const r = await render(rows, 'UTC', { cap: 2 });
  expectUnavailable(r.html);
});
it('foreign response cannot escape family qualification', async () => {
  const r = await render([event(1, { family_id: '10000000-0000-4000-8000-000000000002' })], 'UTC', {
    ignoreFamily: true,
  });
  expectUnavailable(r.html);
});
it('valid monthly master emitting zero occurrences is healthy empty', async () => {
  const r = await render(
    [event(1, { recurrence: 'monthly', starts_at: '2026-09-25T00:00:00Z', ends_at: '2026-09-26T00:00:00Z' })],
    'UTC',
  );
  expect(r.count).toBe(0);
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
});
it.each([{ title: null }, { updated_at: undefined }, { source_recurrence: { unsafe: true } }])(
  'malformed zero-emission master refuses %j',
  async (patch) => {
    const r = await render(
      [
        event(1, {
          recurrence: 'monthly',
          starts_at: '2026-09-25T00:00:00Z',
          ends_at: '2026-09-26T00:00:00Z',
          ...patch,
        }),
      ],
      'UTC',
    );
    expectUnavailable(r.html);
  },
);
it('upcoming5 is presentation only and nearest starts use Tokyo family DATE clock', async () => {
  const date = event(1, {
    title: 'Civil first',
    starts_at: '2026-10-06T00:00:00Z',
    ends_at: '2026-10-07T00:00:00Z',
  });
  const timed = Array.from({ length: 6 }, (_, i) =>
    event(i + 2, { all_day: false, title: `Timed ${i}`, starts_at: `2026-10-05T${16 + i}:00:00Z` }),
  );
  const r = await render([date, ...timed], 'Asia/Tokyo', { cap: 2 });
  const section =
    r.html
      .split('<h2 class="font-semibold">Upcoming Events</h2>')[1]
      ?.split('<h2 class="font-semibold">AI Assistant</h2>')[0] ?? '';
  expect(section).toContain('Civil first');
  expect(at(section, 'Civil first')).toBeLessThan(at(section, 'Timed 0'));
  expect(section).toContain('Timed 3');
  expect(section).not.toContain('Timed 4');
  expect(r.html).toContain(translate(getMessages('en-US'), 'familyDashboard.upcomingEventsMany', { n: 7 }));
});
it('inclusive horizon retains day14 DATE and exact timed point only', async () => {
  const r = await render([
    event(1, { title: 'Day14 DATE', starts_at: '2026-10-19T00:00:00Z', ends_at: '2026-10-20T00:00:00Z' }),
    event(2, { all_day: false, title: 'Exact point', starts_at: '2026-10-19T04:00:00Z' }),
    event(3, { all_day: false, title: 'After point', starts_at: '2026-10-19T04:00:00.001Z' }),
    event(4, { title: 'Day15 DATE', starts_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-21T00:00:00Z' }),
  ]);
  expect(r.html).toContain('Day14 DATE');
  expect(r.html).toContain('Exact point');
  expect(r.html).not.toContain('After point');
  expect(r.html).not.toContain('Day15 DATE');
});
it('ongoing earlier starts are qualified but never promoted into start-based today', async () => {
  const r = await render([event(1, { starts_at: '2026-10-04T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' })]);
  expect(r.count).toBe(0);
  expect(r.html).not.toContain('Synthetic 1');
});
it('recurring native identity stays genuine while React occurrence keys stay stable', async () => {
  const master = event(1, {
    recurrence: 'daily',
    starts_at: '2026-10-01T00:00:00Z',
    ends_at: '2026-10-02T00:00:00Z',
  });
  const first = await render([master]);
  const second = await render([master]);
  const keys = nativeKeys(first.element);
  expect(new Set(keys).size).toBe(6);
  expect(keys.every((key) => JSON.parse(key)[1] === master.id)).toBe(true);
  expect(nativeKeys(second.element)).toEqual(keys);
});
