import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarReadinessEvent } from '@/lib/readiness/calendar-source';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(), createServer: vi.fn(), effectivePlanLevel: vi.fn(), resolveFamilyPlanLevel: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext, effectivePlanLevel: mocks.effectivePlanLevel }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.resolveFamilyPlanLevel }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));
// §51's [Let Bubaly handle it] is a client component inside the horizon cards,
// so the static render needs the two hooks it reaches for. Neither is under
// test here — this file is about what the page reads and what it therefore
// claims; `tests/readiness-assess.test.ts` covers the button's own sentence.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/dashboard/readiness' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import ReadinessPage from '@/app/(app)/dashboard/readiness/page';

type Result<T> = { data: T[] | null; count: number | null; error: unknown };
type Query = { table: string; selection?: string; options?: { count?: string; head?: boolean }; limit?: number; filters: { method: string; key: string; value: unknown }[] };
const result = <T,>(data: T[], count = data.length): Result<T> => ({ data, count, error: null });
let week: Result<CalendarReadinessEvent>;
let tomorrow: Result<CalendarReadinessEvent>;
let roster: Result<{ id: string }>;
// `null` is a configured value, not an unset one: it stands for a count
// query that came back with no count and no error.
let counts: Record<string, number | null>;
let queries: Query[];

function from(table: string) {
  const record: Query = { table, filters: [] };
  queries.push(record);
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: (selection: string, options?: Query['options']) => { record.selection = selection; record.options = options; return query; },
    limit: (limit: number) => { record.limit = limit; return query; },
    order: () => query,
    then: (resolve: (value: unknown) => unknown) => {
      let reply: unknown;
      if (table === 'family_members') reply = roster;
      else if (table === 'calendar_events' && !record.options?.head) reply = record.limit === 200 ? week : tomorrow;
      else if (table === 'meal_plans' && !record.options?.head) reply = result(Array.from({ length: 7 }, (_, i) => ({ plan_date: `2026-09-${String(6 + i).padStart(2, '0')}` })));
      else reply = { data: null, count: table in counts ? counts[table] : (table === 'meal_plans' ? 1 : 0), error: null };
      return Promise.resolve(reply).then(resolve);
    },
  });
  for (const method of ['eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not']) {
    query[method] = (key: string, value: unknown) => { record.filters.push({ method, key, value }); return query; };
  }
  return query;
}

const event = (index: number, assignee = 'one'): CalendarReadinessEvent => ({
  id: `event-${index}`, starts_at: new Date(Date.UTC(2026, 8, 6, 8 + index * 2)).toISOString(),
  ends_at: null, all_day: false, assignee_id: assignee,
});
/**
 * Where the "something could not be read" signal lives after the two readiness
 * implementations merged.
 *
 * It used to grey the ACTIVITY ring to `?` / "Coverage incomplete". That ring
 * is `lib/readiness/score.ts` — a different question ("how much is this family
 * running through Bubaly") whose six inputs are all in `primaryError`, so the
 * page hard-fails rather than render it from a source that failed. Greying it
 * because the CALENDAR read failed said the activity number was untrustworthy
 * when it demonstrably was not, and re-blurred the very line §51 asks the page
 * to draw. The signal now sits with the readiness answer, which is what the
 * coverage is actually about, and the horizon cards still name each missing
 * source underneath.
 */
const COVERAGE_BANNER = 'Readiness is not confirmed while some of it could not be read';

const render = async () => renderToStaticMarkup(await ReadinessPage());

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
  week = result([]);
  tomorrow = result([]);
  roster = result([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
  counts = {};
  queries = [];
  mocks.requireUserContext.mockResolvedValue({ active: { familyId: 'family-1' } });
  mocks.createServer.mockResolvedValue({ from });
  mocks.resolveFamilyPlanLevel.mockResolvedValue(2);
  mocks.effectivePlanLevel.mockResolvedValue(2);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch is forbidden'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readiness page source coverage', () => {
  it('renders the 8/0/0 imbalance using active accessible member IDs, not just event owners', async () => {
    week = result(Array.from({ length: 8 }, (_, i) => event(i)));
    const html = await render();
    expect(html).toContain('1 person carrying a heavy load in the visible calendar');
    expect(html).not.toContain(COVERAGE_BANNER);
    expect(html).not.toContain('Everything ahead looks handled.');
    const members = queries.find((query) => query.table === 'family_members')!;
    expect(members.selection).toBe('id');
    expect(members.options).toEqual({ count: 'exact' });
    expect(members.filters).toContainEqual({ method: 'eq', key: 'family_id', value: 'family-1' });
    expect(members.filters).toContainEqual({ method: 'eq', key: 'is_active', value: true });
  });

  it('can report ready for a successful empty calendar and a complete known roster', async () => {
    const html = await render();
    expect(html).toContain('Everything ahead looks handled.');
    expect(html).not.toContain(COVERAGE_BANNER);
    const weekly = queries.find((query) => query.table === 'calendar_events' && query.limit === 200)!;
    expect(weekly.options).toEqual({ count: 'exact' });
    expect(weekly.filters).toContainEqual({ method: 'gte', key: 'starts_at', value: '2026-09-06T00:00:00Z' });
    expect(weekly.filters).toContainEqual({ method: 'lte', key: 'starts_at', value: '2026-09-13T23:59:59Z' });
  });

  it('shows weekly read failure as unknown while preserving known bills and meal signals', async () => {
    week = { data: null, count: null, error: new Error('Unavailable') };
    counts.bills = 2;
    const html = await render();
    expect(html).toContain('Weekly visible calendar could not be read');
    expect(html).toContain('Workload balance is unknown');
    expect(html).toContain(COVERAGE_BANNER);
    expect(html).toContain('2 bills due');
    expect(html).toContain('7 day(s) of meals planned');
    expect(html).not.toContain('Everything ahead looks handled.');
    // And the ACTIVITY score still reads normally, deliberately. Its six
    // inputs are all in `primaryError`, so the page hard-fails rather than
    // render it from a source that failed — a failed CALENDAR read says
    // nothing about how much this family is running through Bubaly, and
    // greying it would blur the very line §51 asks the page to draw.
    expect(html).toContain('On top of it');
  });

  it('does not turn a count-less document read into "Documents are current"', async () => {
    // A `head: true` count query carries its answer in the Content-Range
    // header. When that header is missing or unparseable, supabase-js reports
    // `{ count: null, error: null }` — there is no error to catch, so the old
    // `n ?? 0` read it as a confirmed zero and the month card printed the ✓.
    // "We could not count your documents" and "your documents are current" are
    // opposite claims; only one of them is safe to invent.
    counts.documents = null;
    const html = await render();
    expect(html).not.toContain('Documents are current');
    expect(html).toContain('Documents could not be read; expiries are unknown');
    expect(html).toContain(COVERAGE_BANNER);
    // The other month rules are untouched by a documents failure: workload is
    // still known from the complete calendar and roster, and still says so.
    expect(html).toContain('The load is spread evenly');
  });

  it('still claims a genuine zero when the count really is zero', async () => {
    // The guard must not swallow the honest answer it exists to protect. A real
    // 0 is a read that succeeded, and the ✓ is earned.
    counts.documents = 0;
    const html = await render();
    expect(html).toContain('Documents are current');
    expect(html).not.toContain('Documents could not be read');
    expect(html).not.toContain(COVERAGE_BANNER);
  });

  it('labels capped conflicts as a lower bound and does not claim exact workload', async () => {
    week = result([event(0), { ...event(1), starts_at: event(0).starts_at },
      ...Array.from({ length: 198 }, (_, i) => ({ ...event(i + 2), all_day: true }))], 201);
    const html = await render();
    expect(html).toContain('At least 1 clash this week');
    expect(html).toContain('Weekly visible calendar is incomplete');
    expect(html).toContain('Workload balance is unknown');
    expect(html).not.toContain('carrying a heavy load');
  });

  it('treats missing count metadata as incomplete even when no rows were returned', async () => {
    week.count = null;
    const html = await render();
    expect(html).toContain(COVERAGE_BANNER);
    expect(html).not.toContain('The week is under control.');
  });

  it('does not turn a failed tomorrow read into a clear tomorrow', async () => {
    tomorrow = { data: null, count: null, error: new Error('Unavailable') };
    const html = await render();
    expect(html).toContain('visible calendar could not be read; conflicts and assignments are unknown');
    expect(html).not.toContain('You&#x27;re set for tomorrow.');
    expect(html).toContain(COVERAGE_BANNER);
  });

  it('retains the existing primary error boundary for a failed roster read', async () => {
    roster = { data: null, count: null, error: new Error('Denied') };
    const html = await render();
    expect(html).toContain('Could not load your family readiness from Supabase. Refresh and try again.');
    expect(html).not.toContain('Looking good');
    expect(html).not.toContain('Everything ahead looks handled.');
  });

  it('does not count missing roster rows as zero-load members', async () => {
    roster = result([{ id: 'one' }], 3);
    week = result(Array.from({ length: 8 }, (_, i) => event(i)));
    const html = await render();
    expect(html).toContain(COVERAGE_BANNER);
    expect(html).toContain('Workload balance is unknown');
    expect(html).not.toContain('carrying a heavy load');
  });

  it('does not expose an inaccessible assignee or label that person as zero load', async () => {
    week = result([...Array.from({ length: 8 }, (_, i) => event(i)), event(9, 'private-member-id')]);
    const html = await render();
    expect(html).toContain('Workload balance is unknown');
    expect(html).not.toContain('private-member-id');
    expect(html).not.toContain('carrying a heavy load');
  });
});
