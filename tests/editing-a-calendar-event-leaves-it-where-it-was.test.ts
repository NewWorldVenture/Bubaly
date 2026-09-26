// Pressing Save on an event you did not edit must not move it.
//
// It moved, by the reader's whole UTC offset, and it moved again on the next
// Save. Two halves of one round trip disagreed about which clock a
// `<input type="datetime-local">` speaks: the modal's prefill read the stored
// instant with browser-LOCAL getters, and the server stamped the box value back
// with a bare `Z` (`asStoredInstant`). Inverses at offset zero and nowhere else.
//
// One 14:30 event, Save pressed three times with no field touched:
//
//   Asia/Tokyo           14:30 -> 23:30 -> 08:30 (next day) -> 17:30
//   America/Los_Angeles  14:30 -> 07:30 -> 00:30 -> 17:30 (previous day)
//   UTC                  14:30 -> 14:30 -> 14:30 -> 14:30   (stable only here)
//
// Rows synced from Google or an ICS feed are genuine instants and drifted the
// same way, which is why the fix cannot depend on knowing what a row means: it
// makes the two ends agree instead (`lib/time/local-input.ts`), on the reader's
// clock — the frame `lib/time/local-day.ts` and
// `tests/a-calendar-day-is-the-readers-day.test.ts` already hold this calendar
// to for every column and every event.
//
// These cases drive the REAL server action against an in-memory Postgres, with
// the REAL prefill and submit helpers the modal uses, under three zones on both
// sides of Greenwich. A test that ran only where it was written could not see
// this defect at all: at offset zero there is nothing to see.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { fromLocalInput, toLocalInput } from '@/lib/time/local-input';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { createCalendarEventAction, updateCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';

const FAMILY = 'family-1';
const SAVE_ONE = '11111111-1111-4111-8111-111111111111';
const ROOT = process.cwd();

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function row() {
  const found = db.table('calendar_events').filter((r) => r.family_id === FAMILY)[0];
  if (!found) throw new Error('the action stored no event');
  return found;
}

/**
 * A timestamp column as it comes back, narrowed rather than coerced. `String()`
 * here would turn a null `ends_at` into "null" and a missing column into
 * "undefined", and both would go on to read as a plausible-looking wall clock.
 */
function stored(field: 'starts_at' | 'ends_at'): string | null {
  const value = row()[field];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`calendar_events.${field} came back as ${typeof value}, not a timestamp`);
}

/**
 * Run a body with the process reading a named zone.
 *
 * Node re-reads `process.env.TZ` and drops its date cache, so this really does
 * move the runtime's clock rather than only labelling the case. The offset
 * assertion is the guard against that stopping being true: without it a silently
 * ignored `TZ` would make every case below vacuous and still green.
 */
async function inZone(tz: string, expectedOffsetMin: number, body: () => Promise<void>) {
  const real = process.env.TZ;
  process.env.TZ = tz;
  try {
    expect(new Date(2026, 8, 10).getTimezoneOffset(), `TZ=${tz} did not take effect`).toBe(expectedOffsetMin);
    await body();
  } finally {
    if (real === undefined) delete process.env.TZ; else process.env.TZ = real;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: {
        description: null, location: null, ends_at: null, all_day: false,
        category: 'general', recurrence: 'none', recurrence_until: null,
        assignee_id: null, idempotency_key: null,
      },
    },
    uniques: { calendar_events: [['family_id', 'idempotency_key']] },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      // Deliberately a fourth zone, and deliberately not what these cases
      // assert. This fix aligns the prefill with the submit on the reader's
      // clock; whose clock a typed time should MEAN when the reader is not in
      // the family's zone is the question `asStoredInstant`'s header defers, and
      // pinning the family zone here would quietly claim it had been answered.
      family: { name: 'Family One', timezone: 'Europe/Amsterdam' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

/** Everything the modal does between opening an event and calling the action. */
async function saveWithNothingEdited(eventId: string) {
  const startsBox = toLocalInput(stored('starts_at'));
  const endsBox = toLocalInput(stored('ends_at'));
  const result = await updateCalendarEventAction(eventId, {
    startsAt: fromLocalInput(startsBox) ?? '',
    endsAt: fromLocalInput(endsBox) ?? null,
  });
  expect(result.ok, result.ok ? '' : result.error).toBe(true);
  return { startsBox, endsBox };
}

// 14:30 on the reader's wall, in three zones, is three different instants — and
// each is asserted outright, so a fix that merely made the round trip stable
// around the WRONG instant would not pass.
const ZONES = [
  { tz: 'UTC', offsetMin: 0, starts: '2026-09-10T14:30:00.000Z', ends: '2026-09-10T16:00:00.000Z' },
  { tz: 'Asia/Tokyo', offsetMin: -540, starts: '2026-09-10T05:30:00.000Z', ends: '2026-09-10T07:00:00.000Z' },
  { tz: 'America/Los_Angeles', offsetMin: 420, starts: '2026-09-10T21:30:00.000Z', ends: '2026-09-10T23:00:00.000Z' },
] as const;

describe('a Save with nothing edited leaves the event where it was', () => {
  it.each(ZONES)('in $tz, three Saves in a row never move it', async ({ tz, offsetMin, starts, ends }) => {
    await inZone(tz, offsetMin, async () => {
      const created = await createCalendarEventAction({
        title: 'School concert',
        startsAt: fromLocalInput('2026-09-10T14:30') ?? '',
        endsAt: fromLocalInput('2026-09-10T16:00') ?? null,
        submissionId: SAVE_ONE,
      });
      expect(created.ok, created.ok ? '' : created.error).toBe(true);
      if (!created.ok) return;

      // The zone half: what "14:30 here" is an instant-of.
      expect(stored('starts_at')).toBe(starts);
      expect(stored('ends_at')).toBe(ends);

      for (let save = 1; save <= 3; save += 1) {
        const { startsBox, endsBox } = await saveWithNothingEdited(created.id);
        // The box showed the parent the time they typed, every time...
        expect(startsBox, `save ${save} prefilled the wrong wall clock`).toBe('2026-09-10T14:30');
        expect(endsBox, `save ${save} prefilled the wrong end`).toBe('2026-09-10T16:00');
        // ...and the instant half: the row did not budge.
        expect(stored('starts_at'), `save ${save} moved the event`).toBe(starts);
        expect(stored('ends_at'), `save ${save} moved the end`).toBe(ends);
      }
    });
  });

  it.each(ZONES)('in $tz, an event synced as a real instant survives being edited', async ({ tz, offsetMin }) => {
    // A Google or ICS row is a genuine instant. Nothing in the column says so,
    // so the round trip has to hold it still without being told — which is why
    // the fix is "the two ends agree", not "guess what the row meant".
    await inZone(tz, offsetMin, async () => {
      const synced = '2026-09-10T00:00:00.000Z';
      const created = await createCalendarEventAction({
        title: 'Flight', startsAt: synced, endsAt: '2026-09-10T02:00:00.000Z', submissionId: SAVE_ONE,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(stored('starts_at')).toBe(synced);

      await saveWithNothingEdited(created.id);
      await saveWithNothingEdited(created.id);
      expect(stored('starts_at'), 'editing a synced event moved it').toBe(synced);
      expect(stored('ends_at')).toBe('2026-09-10T02:00:00.000Z');
    });
  });

  it('an all-day row keeps its flag and its instant through an edit', async () => {
    // `all_day` is a boolean beside a `timestamptz`, so an all-day row still
    // carries a zone-bound instant. Which instant it OUGHT to carry is part of
    // the deferred question; that it must not slide nine hours per Save is not.
    await inZone('Asia/Tokyo', -540, async () => {
      const created = await createCalendarEventAction({
        title: 'Sports day', startsAt: '2026-09-10T00:00:00.000Z', allDay: true, submissionId: SAVE_ONE,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      await saveWithNothingEdited(created.id);
      await saveWithNothingEdited(created.id);
      expect(stored('starts_at')).toBe('2026-09-10T00:00:00.000Z');
      expect(row().all_day).toBe(true);
    });
  });

  it('the hour a spring-forward skips resolves to one that exists, and then holds', async () => {
    // America/Chicago goes 02:00 -> 03:00 on 8 March 2026, so 02:30 is a reading
    // that never happens. It resolves forward to the first one that does — the
    // choice `instantForLocalTime` makes — rather than becoming a silently wrong
    // instant, and from there the round trip closes like any other.
    // 300, not 360: `inZone` probes a September date, and Chicago is on CDT then.
    await inZone('America/Chicago', 300, async () => {
      const resolved = fromLocalInput('2026-03-08T02:30');
      expect(resolved).toBe('2026-03-08T08:30:00.000Z');
      expect(toLocalInput(resolved)).toBe('2026-03-08T03:30');

      const created = await createCalendarEventAction({
        title: 'Early start', startsAt: resolved ?? '', submissionId: SAVE_ONE,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await saveWithNothingEdited(created.id);
      expect(stored('starts_at')).toBe('2026-03-08T08:30:00.000Z');
    });
  });
});

describe('the modal hands the action an instant, not a box value', () => {
  const MODULE = join(ROOT, 'components/modules/calendar-module.tsx');
  const src = () => readFileSync(MODULE, 'utf8');

  it('reads its prefill and writes its submit through the same pair', () => {
    // The defect was not either function being wrong on its own. It was one end
    // using a different clock from the other, so what has to be pinned is that
    // both ends come from the one module that keeps them inverses.
    expect(src()).toMatch(/import \{ fromLocalInput, toLocalInput \} from '@\/lib\/time\/local-input'/);
    expect(src()).toMatch(/startsAt: fromLocalInput\(parsed\.data\.starts_at\)/);
    expect(src()).toMatch(/endsAt: fromLocalInput\(parsed\.data\.ends_at\)/);
  });

  it('keeps no private copy of the conversion to drift from the shared one', () => {
    expect(src()).not.toMatch(/function toLocalInput/);
    expect(src()).not.toMatch(/function fromLocalInput/);
  });
});

describe('the mismatch itself, pinned', () => {
  // The two real functions as they were paired, replayed in a child process so
  // the zone is the runtime's rather than a label. If this ever stops drifting,
  // something changed underneath and the whole finding needs re-deriving.
  const OLD_PAIR = `
    const pad = (n) => String(n).padStart(2, '0');
    const prefill = (iso) => { const d = new Date(iso);
      return \`\${d.getFullYear()}-\${pad(d.getMonth()+1)}-\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}\`; };
    const store = (v) => /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$/.test(v) ? v + 'Z' : v;
    let stored = store('2026-09-10T14:30');
    const seen = [stored];
    for (let i = 0; i < 3; i++) { stored = store(prefill(stored)); seen.push(stored); }
    process.stdout.write(seen.join(' '));
  `;

  it.each(['Asia/Tokyo', 'America/Los_Angeles', 'Europe/Amsterdam'])('drifts in %s, which is the bug', (tz) => {
    const seen = execFileSync(process.execPath, ['-e', OLD_PAIR], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8',
    }).split(' ');
    expect(new Set(seen).size, `${tz}: ${seen.join(' ')}`).toBe(4);
  });

  it('is invisible at offset zero, which is why it survived', () => {
    const seen = execFileSync(process.execPath, ['-e', OLD_PAIR], {
      env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8',
    }).split(' ');
    expect(new Set(seen).size).toBe(1);
  });
});

afterAll(() => { /* TZ is restored per case by `inZone`; nothing is left set. */ });
