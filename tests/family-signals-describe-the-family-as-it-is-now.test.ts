// Three defects in how the hard family signals are worked out, each driven
// through the real runSignalDetection (the Refresh action's and the nightly
// model-refresh cron's code) against the in-memory database.
//
// N9  — a signal was never retired. The scan only upserted what it found, so
//       last month's budget drift stayed 'active' after spending came back
//       under the cap, and a crunch time that moved left two contradicting
//       cards, both feeding the reasoning report and the AI's context. And the
//       drift's key had no period, so acknowledging one month hid every later
//       month's.
// N12 — the stress window bucketed events on Greenwich's weekday and hour. For a
//       family in Los Angeles a Friday-evening game is a Saturday 01:00Z
//       "weekend morning".
// N13 — routine adherence read 21 days of events and expected 28: every
//       routine scored at most 75%, and one kept 79% of the time was flagged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-hs';
const DAY = 86_400_000;
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
let db: InMemorySupabase;
let seq = 0;

const scan = async (now: Date, tz = 'UTC') => {
  const result = await runSignalDetection(db as unknown as DB, FAMILY, 'en-US', echo, now, tz);
  expect(result.ok).toBe(true);
};
const active = (kind?: string) => db.table('family_signals')
  .filter((s) => s.status === 'active' && (!kind || s.kind === kind))
  .map((s) => s.subject_key).sort();
const event = (title: string, at: string) => ({
  id: `ev-${String(++seq).padStart(4, '0')}`, family_id: FAMILY, title, starts_at: at, ends_at: null, assignee_id: null,
});
const spend = (amount: number, date: string) => ({
  id: `tx-${String(++seq).padStart(4, '0')}`, family_id: FAMILY, type: 'expense', category: 'Groceries', amount, date,
});

beforeEach(() => {
  db = createInMemorySupabase({
    maxRows: 1000,
    uniques: { family_signals: [['family_id', 'kind', 'subject_key']] },
    defaults: { family_signals: { status: 'active' } },
  });
  seq = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('budgets', [{ id: 'b-1', family_id: FAMILY, category: 'Groceries', amount: 500, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
});

describe('N9 — a pattern that has stopped is not still on the board', () => {
  it('budget drift goes when spending is back under the cap', async () => {
    db.seed('transactions', [spend(600, '2026-10-05')]);
    await scan(new Date('2026-10-14T12:00:00Z'));
    expect(active('budget_drift')).toEqual(['budget:groceries:2026-10-01']);

    // The overspend was a mistake and was corrected.
    db.replace('transactions', [spend(300, '2026-10-05')]);
    await scan(new Date('2026-10-15T12:00:00Z'));
    expect(active('budget_drift')).toEqual([]);
  });

  it('a crunch time that moved is one card, not two that contradict each other', async () => {
    const evenings = Array.from({ length: 6 }, () => event('Practice', '2026-10-13T19:00:00Z'));
    db.seed('calendar_events', evenings);
    await scan(new Date('2026-10-14T12:00:00Z'));
    expect(active('stress_window')).toEqual(['stress_window:weekday:evening']);

    db.replace('calendar_events', Array.from({ length: 6 }, () => event('Swim', '2026-10-13T08:00:00Z')));
    await scan(new Date('2026-10-15T12:00:00Z'));
    expect(active('stress_window')).toEqual(['stress_window:weekday:morning']);
  });

  it('a decision is kept: an acknowledged pattern that stopped is not deleted', async () => {
    db.seed('transactions', [spend(600, '2026-10-05')]);
    await scan(new Date('2026-10-14T12:00:00Z'));
    db.table('family_signals')[0].status = 'acknowledged';
    db.replace('transactions', []);
    await scan(new Date('2026-10-15T12:00:00Z'));
    expect(db.table('family_signals').map((s) => [s.subject_key, s.status])).toEqual([['budget:groceries:2026-10-01', 'acknowledged']]);
  });

  it('acknowledging one month\'s drift does not hide the next month\'s', async () => {
    db.seed('transactions', [spend(600, '2026-09-05')]);
    await scan(new Date('2026-09-20T12:00:00Z'));
    db.table('family_signals').find((s) => s.kind === 'budget_drift')!.status = 'acknowledged';

    db.seed('transactions', [spend(700, '2026-10-05')]);
    await scan(new Date('2026-10-14T12:00:00Z'));
    expect(active('budget_drift')).toEqual(['budget:groceries:2026-10-01']);
  });
});

describe('N12 — the crunch time is the family\'s weekday and hour', () => {
  it('Friday-evening games in Los Angeles are weekday evenings, not weekend mornings', async () => {
    // Friday 2026-10-09, 18:00 in Los Angeles = Saturday 01:00Z.
    db.seed('calendar_events', Array.from({ length: 6 }, () => event('Game', '2026-10-10T01:00:00Z')));
    await scan(new Date('2026-10-14T12:00:00Z'), 'America/Los_Angeles');
    expect(active('stress_window')).toEqual(['stress_window:weekday:evening']);
    expect(db.table('family_signals').find((s) => s.kind === 'stress_window')!.title).toBe('Weekday evenings are your crunch time');
  });

  it('a Tokyo family\'s Monday 08:00 is a weekday morning, not Sunday evening', async () => {
    // Monday 2026-10-12, 08:00 in Tokyo = Sunday 23:00Z.
    db.seed('calendar_events', Array.from({ length: 6 }, () => event('School run', '2026-10-11T23:00:00Z')));
    await scan(new Date('2026-10-14T12:00:00Z'), 'Asia/Tokyo');
    expect(active('stress_window')).toEqual(['stress_window:weekday:morning']);
  });
});

describe('N13 — a routine is judged on the four weeks it is expected over', () => {
  const NOW = new Date('2026-10-14T18:00:00Z');
  /** "Bedtime" on the calendar on every one of the last 28 days except `skipped`. */
  const bedtimes = (skipped: number[]) => Array.from({ length: 28 }, (_, i) => i + 1)
    .filter((daysAgo) => !skipped.includes(daysAgo))
    .map((daysAgo) => event('Bedtime story', new Date(NOW.getTime() - daysAgo * DAY + 3_600_000).toISOString()));

  beforeEach(() => {
    db.seed('routine_templates', [{ id: 'r-bed', family_id: FAMILY, name: 'Bedtime', weekday_mask: 127, is_active: true }]);
  });

  it('kept 22 nights of 28 (79%) is sticking, not "only sticks 54% of the time"', async () => {
    db.seed('calendar_events', bedtimes([3, 7, 11, 15, 19, 23]));
    await scan(NOW);
    expect(active('routine_adherence')).toEqual([]);
  });

  it('kept every night is not flagged, and kept 14 of 28 still is, at 50%', async () => {
    db.seed('calendar_events', bedtimes([]));
    await scan(NOW);
    expect(active('routine_adherence')).toEqual([]);

    db.replace('calendar_events', bedtimes(Array.from({ length: 14 }, (_, i) => 2 * i + 1)));
    await scan(new Date(NOW.getTime() + 60_000));
    expect(active('routine_adherence')).toEqual(['routine_adherence:r-bed']);
    expect(db.table('family_signals').find((s) => s.kind === 'routine_adherence')!.evidence).toMatchObject({ actual: 14, expected: 28, adherencePct: 50 });
  });
});
