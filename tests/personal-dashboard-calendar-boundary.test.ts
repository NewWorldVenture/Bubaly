import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { MemberRole } from '@/lib/constants/roles';
import { at } from '@/tests/helpers/source-order';
import type { ComponentProps } from 'react';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';
import { orPredicate, type Row } from '@/tests/helpers/in-memory-supabase';
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
import { PersonalDashboard } from '@/components/dashboard/personal-dashboard';
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
    role?: MemberRole;
  } = {},
) {
  const calls: URL[] = [];
  h.db = createClient<Database>('https://personal-dashboard.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const u = new URL(String(input));
        expect(u.origin).toBe('https://personal-dashboard.synthetic.invalid');
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
      role: options.role ?? 'caregiver',
      member: {
        id: '20000000-0000-4000-8000-000000000001',
        user_id: '30000000-0000-4000-8000-000000000001',
        display_name: 'Synthetic',
      },
    },
  };
  // Only the caller identity and family/member fields consumed by this surface
  // are projected here; no Auth/session acceptance is inferred from this fixture.
  const element = await PersonalDashboard({ ctx: ctx as unknown as UserContext });
  const html = renderToStaticMarkup(element);
  return {
    html,
    calls,
    element,
    count: Number([...html.matchAll(/text-2xl font-bold leading-none">(\d+)<\/p>/g)][1]?.[1]),
  };
}
beforeEach(() => {
  h.enabled = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
const MEMBER = '20000000-0000-4000-8000-000000000001';
function coming(html: string) {
  return html.split('<h2 class="font-semibold">Coming Up</h2>')[1]?.split('Quick actions')[0] ?? '';
}
it.each(['UTC', 'Asia/Tokyo'])('healthy %s canonical todayDATE', async (zone) => {
  expect((await render([event()], zone)).count).toBe(1);
});
it('healthy NY timed today and future tomorrow', async () => {
  const r = await render([
    event(1, { all_day: false, title: 'Timed today', starts_at: '2026-10-05T14:00:00Z' }),
    event(2, { all_day: false, title: 'Timed tomorrow', starts_at: '2026-10-06T14:00:00Z' }),
  ]);
  expect(r.count).toBe(1);
  expect(coming(r.html)).toContain('Timed tomorrow');
});
it('healthy assigned-to-me and shared events are included while anothermember excluded', async () => {
  const r = await render([
    event(1, { all_day: false, starts_at: '2026-10-05T14:00:00Z', assignee_id: MEMBER }),
    event(2, { all_day: false, starts_at: '2026-10-05T15:00:00Z' }),
    event(3, {
      all_day: false,
      title: 'Other member',
      starts_at: '2026-10-05T16:00:00Z',
      assignee_id: '20000000-0000-4000-8000-000000000002',
    }),
  ]);
  expect(r.count).toBe(2);
  expect(r.html).not.toContain('Other member');
});
it('healthy foreignfamily response is filtered', async () => {
  expect((await render([event(1, { family_id: '10000000-0000-4000-8000-000000000002' })])).count).toBe(0);
});
it('NY civil todayDATE must appear today', async () => {
  expect((await render([event()])).count).toBe(1);
});
it('NY civil tomorrowDATE must not appear today', async () => {
  expect(
    (await render([event(1, { starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' })])).count,
  ).toBe(0);
});
it('NY civil tomorrowDATE must appear upcoming', async () => {
  const r = await render([
    event(1, { title: 'Civil tomorrow', starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' }),
  ]);
  expect(coming(r.html)).toContain('Civil tomorrow');
});
it('NY civil Oct7 upcoming badge must show7', async () => {
  const r = await render([
    event(1, { title: 'Later DATE', starts_at: '2026-10-07T00:00:00Z', ends_at: '2026-10-08T00:00:00Z' }),
  ]);
  expect(r.html).toContain('Later DATE');
  expect(r.html).toContain('text-base font-black leading-none">7</p>');
});
it('prior daily recurring master assigned to me must appear today', async () => {
  expect(
    (
      await render([
        event(1, {
          assignee_id: MEMBER,
          recurrence: 'daily',
          starts_at: '2026-10-01T00:00:00Z',
          ends_at: '2026-10-02T00:00:00Z',
        }),
      ])
    ).count,
  ).toBe(1);
});
it('provider cap2 must not become MyEventsToday2of3', async () => {
  expect(
    (
      await render(
        [1, 2, 3].map((n) => event(n, { all_day: false, starts_at: `2026-10-05T${10 + n}:00:00Z` })),
        'UTC',
        { cap: 2 },
      )
    ).count,
  ).toBe(3);
});
it('presentation8 must not become MyEventsToday8of9', async () => {
  expect(
    (
      await render(
        Array.from({ length: 9 }, (_, i) => event(i + 1)),
        'UTC',
      )
    ).count,
  ).toBe(9);
});
it('calendar403 must not become knownempty MyDay/ComingUp', async () => {
  const r = await render([event()], 'UTC', { error: true });
  expect(r.html).not.toContain(
    translate(getMessages('en-US'), 'personalDashboard.nothingOnYourScheduleToday'),
  );
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'personalDashboard.nothingComingUp'));
});
it.each(['2026-03-08T12:00:00Z', '2026-11-01T12:00:00Z'])('NY DST civil today%s', async (now) => {
  vi.setSystemTime(new Date(now));
  const day = now.slice(0, 10),
    end = day === '2026-03-08' ? '2026-03-09' : '2026-11-02';
  expect(
    (await render([event(1, { starts_at: day + 'T00:00:00Z', ends_at: end + 'T00:00:00Z' })])).count,
  ).toBe(1);
});
it('Tokyo nextday DATE must rank ahead of6 later timed entries before top5', async () => {
  const date = event(1, {
      title: 'Civil first',
      starts_at: '2026-10-06T00:00:00Z',
      ends_at: '2026-10-07T00:00:00Z',
    }),
    timed = Array.from({ length: 6 }, (_, i) =>
      event(i + 2, { all_day: false, title: `Timed ${i}`, starts_at: `2026-10-05T${16 + i}:00:00Z` }),
    );
  const r = await render([date, ...timed], 'Asia/Tokyo');
  expect(coming(r.html)).toContain('Civil first');
  expect(coming(r.html)).not.toContain('Timed 4');
});
it('provider cap2 must read complete nearest5upcoming', async () => {
  const r = await render(
    Array.from({ length: 5 }, (_, i) =>
      event(i + 1, {
        title: `Upcoming ${i}`,
        starts_at: '2026-10-06T00:00:00Z',
        ends_at: '2026-10-07T00:00:00Z',
      }),
    ),
    'UTC',
    { cap: 2 },
  );
  expect(coming(r.html)).toContain('Upcoming 4');
});
it('genuine inclusive day14 timed endpoint stays visible', async () => {
  const r = await render([
    event(1, { all_day: false, title: 'Exact endpoint', starts_at: '2026-10-19T04:00:00Z' }),
    event(2, { all_day: false, title: 'After endpoint', starts_at: '2026-10-19T04:00:00.001Z' }),
  ]);
  expect(r.html).toContain('Exact endpoint');
  expect(r.html).not.toContain('After endpoint');
});
it('caregiver ComingUp statistic must not confuse presentation5 with actual7', async () => {
  const r = await render(
    Array.from({ length: 7 }, (_, i) =>
      event(i + 1, { starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' }),
    ),
    'UTC',
  );
  const stats = [...r.html.matchAll(/text-2xl font-bold leading-none">(\d+)<\/p>/g)].map((m) => Number(m[1]));
  expect(stats[3]).toBe(7);
});
function nativeKeys(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(nativeKeys);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    ...(typeof node.key === 'string' && node.key.startsWith('["native",') ? [node.key] : []),
    ...nativeKeys(node.props.children),
  ];
}
function unavailable(html: string, upcoming = true) {
  expect(html).toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
  expect(html).not.toContain(translate(getMessages('en-US'), 'personalDashboard.nothingOnYourScheduleToday'));
  if (upcoming) {
    expect(html).toContain(translate(getMessages('en-US'), 'homeCalendar.upcomingUnavailable'));
    expect(html).not.toContain(translate(getMessages('en-US'), 'personalDashboard.nothingComingUp'));
  }
  expect(html).toContain('text-2xl font-bold leading-none">—</p>');
}
it('healthy empty personal calendar retains true empty copy', async () => {
  const r = await render([]);
  expect(r.count).toBe(0);
  expect(r.html).toContain(translate(getMessages('en-US'), 'personalDashboard.nothingOnYourScheduleToday'));
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
});
it('source mode stays held before calendarHTTP', async () => {
  h.enabled = true;
  const r = await render([event()]);
  unavailable(r.html);
  expect(r.calls.filter((u) => u.pathname.endsWith('/calendar_events'))).toHaveLength(0);
});
it.each([{ laterError: true }, { missingCount: true }, { drift: true }, { count: 20001 }])(
  'complete personal domain refuses unreliable paging %j',
  async (options) => {
    const r = await render(
      [1, 2, 3].map((n) => event(n)),
      'UTC',
      { cap: 2, ...options },
    );
    unavailable(r.html);
  },
);
it.each([
  { title: null },
  { created_at: undefined },
  { updated_at: 'bad-clock' },
  { feed_id: undefined },
  { source_recurrence: { unsafe: true } },
  { starts_at: '2026-10-05T03:00:00Z' },
])('malformed raw row201 refuses before memberfilter and caps %j', async (patch) => {
  const rows = Array.from({ length: 201 }, (_, i) => event(i + 1, i === 200 ? patch : {}));
  unavailable((await render(rows, 'UTC', { cap: 2 })).html);
});
it('foreign projection cannot be adopted through the personalfilter', async () => {
  unavailable(
    (
      await render([event(1, { family_id: '10000000-0000-4000-8000-000000000002' })], 'UTC', {
        ignoreFamily: true,
      })
    ).html,
  );
});
it('healthy authorized othermember events never render or count', async () => {
  const r = await render([
    event(1, { title: 'Other today', assignee_id: '20000000-0000-4000-8000-000000000002' }),
    event(2, {
      title: 'Other tomorrow',
      assignee_id: '20000000-0000-4000-8000-000000000002',
      starts_at: '2026-10-06T00:00:00Z',
      ends_at: '2026-10-07T00:00:00Z',
    }),
  ]);
  expect(r.count).toBe(0);
  expect(r.html).not.toContain('Other today');
  expect(r.html).not.toContain('Other tomorrow');
});
it('conservative whole authorizedfamily qualification precedes personalfilter', async () => {
  const r = await render([event(1, { title: null, assignee_id: '20000000-0000-4000-8000-000000000002' })]);
  unavailable(r.html);
});
it('valid zero-emission monthly master remains healthyempty', async () => {
  const r = await render(
    [event(1, { recurrence: 'monthly', starts_at: '2026-09-25T00:00:00Z', ends_at: '2026-09-26T00:00:00Z' })],
    'UTC',
  );
  expect(r.count).toBe(0);
  expect(r.html).not.toContain(translate(getMessages('en-US'), 'homeCalendar.todayUnavailable'));
});
it.each([{ title: null }, { updated_at: undefined }, { source_recurrence: { unsafe: true } }])(
  'zero-emission malformedmaster refuses %j',
  async (patch) => {
    unavailable(
      (
        await render(
          [
            event(1, {
              recurrence: 'monthly',
              starts_at: '2026-09-25T00:00:00Z',
              ends_at: '2026-09-26T00:00:00Z',
              ...patch,
            }),
          ],
          'UTC',
        )
      ).html,
    );
  },
);
it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const)(
  'role%s preserves own/shared calendar and conditionalupcoming',
  async (role) => {
    const r = await render(
      [
        event(1, { title: 'Own today', assignee_id: MEMBER }),
        event(2, {
          title: 'Shared tomorrow',
          starts_at: '2026-10-06T00:00:00Z',
          ends_at: '2026-10-07T00:00:00Z',
        }),
      ],
      'UTC',
      { role },
    );
    expect(r.count).toBe(1);
    expect(r.html).toContain('Own today');
    if (role === 'caregiver' || role === 'guest') expect(coming(r.html)).toContain('Shared tomorrow');
    else expect(coming(r.html)).toBe('');
  },
);
it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const)(
  'role%s renders unavailable insteadofcalendarzero on403',
  async (role) => {
    unavailable(
      (await render([event()], 'UTC', { role, error: true })).html,
      role === 'caregiver' || role === 'guest',
    );
  },
);
it('day14 DATE and exact timedendpoint remain visible while followingday and instant refuse selection', async () => {
  const r = await render([
    event(1, { title: 'Last DATE', starts_at: '2026-10-19T00:00:00Z', ends_at: '2026-10-20T00:00:00Z' }),
    event(2, { all_day: false, title: 'Last point', starts_at: '2026-10-19T04:00:00Z' }),
    event(3, { all_day: false, title: 'Too late', starts_at: '2026-10-19T04:00:00.001Z' }),
    event(4, { title: 'Next DATE', starts_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-21T00:00:00Z' }),
  ]);
  expect(coming(r.html)).toContain('Last DATE');
  expect(coming(r.html)).toContain('Last point');
  expect(r.html).not.toContain('Too late');
  expect(r.html).not.toContain('Next DATE');
});
it('ongoing earlierstarts never promoted into today', async () => {
  const r = await render([
    event(1, { title: 'Earlier span', starts_at: '2026-10-04T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' }),
  ]);
  expect(r.count).toBe(0);
  expect(r.html).not.toContain('Earlier span');
});
it('recurring nativeIDs remain genuine with stable distinct occurrencekeys', async () => {
  const master = event(1, {
      assignee_id: MEMBER,
      recurrence: 'daily',
      starts_at: '2026-10-01T00:00:00Z',
      ends_at: '2026-10-02T00:00:00Z',
    }),
    first = await render([master]),
    second = await render([master]);
  const keys = nativeKeys(first.element);
  expect(keys).toHaveLength(6);
  expect(new Set(keys).size).toBe(6);
  expect(keys.every((key) => JSON.parse(key)[1] === master.id)).toBe(true);
  expect(nativeKeys(second.element)).toEqual(keys);
});
it('Tokyo mixed DATE actualstart precedes later clockstarts with presencechecked ordering', async () => {
  const r = await render(
    [
      event(1, { title: 'Civil first', starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z' }),
      event(2, { all_day: false, title: 'Timed next', starts_at: '2026-10-05T16:00:00Z' }),
    ],
    'Asia/Tokyo',
  );
  expect(at(coming(r.html), 'Civil first')).toBeLessThan(at(coming(r.html), 'Timed next'));
});
