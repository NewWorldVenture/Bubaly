// An ICS feed is authoritative, so a short answer is a deletion instruction.
//
// `GET /api/sync/feeds/<token>` is what Apple Calendar, Outlook, Google
// ("From URL") and Alexa subscribe to. Those clients do not merge a feed into
// what they already hold — they RECONCILE against it. An event present last
// poll and absent from this one is an event the client removes from the user's
// calendar. A 200 carrying fewer rows than the calendar holds is therefore not
// a degraded read; it is an instruction to delete the difference, obeyed
// silently on every subscribed device.
//
// `readAll` returns the rows it gathered BEFORE a failed page alongside the
// error, precisely so a caller can tell a partial read from a complete one.
// This route destructured only `rows` and published them. A transport blip on
// page two emptied a family's subscribed calendar down to the first thousand
// events; the next successful poll put them back. An appointment that vanishes
// and reappears is worse than one that never loaded, because the family stops
// trusting the calendar rather than the network.
//
// The cron on the other side of the same seam (app/api/cron/calendar-feeds)
// always checked this read's error. The public feed — the one where the cost is
// highest — was the single place that did not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  calendar: null as Row | null,
  events: [] as Row[],
  /** Rows the fake server will answer with at most, whatever range was asked for. */
  serverPageCap: 1000,
  /** Fail the read once this many rows have already been handed out. */
  failAfterRows: null as number | null,
  /** Every `.order(column, options)` applied to the events query, in order. */
  eventOrder: [] as { column: string; ascending: boolean }[],
  handedOut: 0,
}));

vi.mock('@/lib/server/rate-limit', () => ({
  clientIp: () => '203.0.113.9',
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
}));
vi.mock('@/lib/server/rate-limit-db', () => ({
  rateLimitDb: async () => ({ ok: true, retryAfter: 0 }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const builder: Row = {};
      let range: [number, number] | null = null;
      const settle = () => {
        if (table !== 'sync_calendar_events') return { data: [], error: null };
        const [from, to] = range ?? [0, state.events.length - 1];
        const asked = state.events.slice(from, to + 1).slice(0, state.serverPageCap);
        if (state.failAfterRows !== null && state.handedOut >= state.failAfterRows) {
          return { data: null, error: { message: 'connection reset by peer' } };
        }
        state.handedOut += asked.length;
        return { data: asked, error: null };
      };
      Object.assign(builder, {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        lte: () => builder,
        order: (column: string, options?: { ascending?: boolean }) => {
          if (table === 'sync_calendar_events') {
            state.eventOrder.push({ column, ascending: options?.ascending !== false });
          }
          return builder;
        },
        limit: () => builder,
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        maybeSingle: async () => ({ data: state.calendar, error: null }),
        then: (resolve: (value: unknown) => void) => resolve(settle()),
      });
      return builder;
    },
  }),
}));

const { GET } = await import('@/app/api/sync/feeds/[token]/route');

const TOKEN = 'feedtoken0123456789';

const call = (token = TOKEN) =>
  GET(new Request(`https://bubaly.test/api/sync/feeds/${token}`) as never, {
    params: Promise.resolve({ token }),
  });

function seedEvents(count: number) {
  const day = 24 * 60 * 60 * 1000;
  state.events = Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    uid: `evt-${i}@bubaly.test`,
    title: `Event ${i}`,
    description: null,
    location: null,
    // Ascending, so row order matches calendar order: row 0 is soonest.
    starts_at: new Date(Date.UTC(2026, 0, 1) + i * day).toISOString(),
    ends_at: new Date(Date.UTC(2026, 0, 1) + i * day + 3600_000).toISOString(),
    all_day: false,
    recurrence_rule: null,
    status: 'confirmed',
    updated_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  }));
}

beforeEach(() => {
  state.calendar = { id: 'cal-1', name: 'Hughen Family', description: null, timezone: 'UTC', feed_enabled: true };
  state.events = [];
  state.serverPageCap = 1000;
  state.failAfterRows = null;
  state.eventOrder = [];
  state.handedOut = 0;
});
afterEach(() => vi.clearAllMocks());

describe('a calendar feed never publishes a short list', () => {
  it('publishes every event when the read completes', async () => {
    seedEvents(3);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/calendar');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    for (const event of state.events) expect(body).toContain(String(event.uid));
  });

  it('refuses to answer 200 when a page of the event read fails', async () => {
    // THE CASE THE ROUTE COULD NOT SEE. 1,500 events, the server answers the
    // first page and then drops the connection. `readAll` hands back the
    // thousand it has plus the error; publishing them tells every subscriber to
    // delete the other five hundred.
    seedEvents(1500);
    state.failAfterRows = 1000;

    const res = await call();

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
    // Nothing a subscriber could reconcile against: not a calendar document at
    // all, and in particular not the truncated one.
    const body = await res.text();
    expect(body).not.toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('evt-0@bubaly.test');
    // A failed feed must not be cached and re-served as the calendar's truth.
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('still publishes a calendar that needs several pages to read', async () => {
    // NOT BLIND. Same 1,500 events across the same two pages, nothing failing:
    // the answer is the whole calendar, so the 503 above is keyed on the error
    // and not merely on a multi-page read.
    seedEvents(1500);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('evt-0@bubaly.test');
    expect(body).toContain('evt-1499@bubaly.test');
  });

  it('orders the paged read so the row ceiling drops the furthest-out events', async () => {
    // The read is capped at `max: 2000`. That ceiling is silent — it returns no
    // error — so it is a deletion instruction too, and the ORDER decides which
    // events it deletes. Ascending `starts_at` puts the cut at the far end of a
    // 400-day horizon, where the next poll's rolling window recovers it. Reorder
    // this read by `id` and the cut lands on arbitrary events, next week's
    // dentist appointment as readily as a birthday fourteen months out.
    seedEvents(5);
    await call();
    expect(state.eventOrder[0]).toEqual({ column: 'starts_at', ascending: true });
  });

  it('answers 404 for a token no enabled calendar owns', async () => {
    state.calendar = null;
    const res = await call();
    expect(res.status).toBe(404);
  });
});
