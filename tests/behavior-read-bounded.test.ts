import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { between } from './helpers/source-order';

// A-05 (agent-05 / CLAUDE-FRONTEND-01, PLA-0813): behavior-module loaded a
// family's ENTIRE behavior_logs history (`.select('*').eq(family_id).order(...)`
// with no bound) on every mount and every realtime change. behavior_logs grows
// unbounded over a family's lifetime, so the client payload grows without limit
// (§25 performance/reliability). Every view here is recent-focused (6-week trend,
// streaks, recent list), so the read is now bounded to a rolling 365-day window
// hard-capped at 1000 rows.

const src = fs.readFileSync('components/modules/behavior-module.tsx', 'utf8');
const care = fs.readFileSync('components/modules/care-module.tsx', 'utf8');
const security = fs.readFileSync('components/modules/security-module.tsx', 'utf8');
const scorecard = fs.readFileSync('components/modules/experience-scorecard-module.tsx', 'utf8');
const nextActions = fs.readFileSync('components/modules/next-actions-module.tsx', 'utf8');
const briefing = fs.readFileSync('components/modules/briefing-module.tsx', 'utf8');

describe('A-05 growth-table module reads are bounded (perf)', () => {
  it('behavior_logs: rolling window AND a hard row cap', () => {
    const fetcher = src.slice(src.indexOf("table: 'behavior_logs'"), src.indexOf('const [memberFilter'));
    expect(fetcher).toContain(".gte('occurred_at'");
    expect(fetcher).toMatch(/\.limit\(1000\)/);
    // The window is derived from now(), so it rolls forward with realtime refetches.
    expect(fetcher).toContain('Date.now()');
  });

  it('care_log: rolling window AND a hard row cap', () => {
    const fetcher = care.slice(care.indexOf("table: 'care_log'"), care.indexOf("const memberName"));
    expect(fetcher).toContain(".gte('occurred_at'");
    expect(fetcher).toMatch(/\.limit\(1000\)/);
    expect(fetcher).toContain('Date.now()');
  });

  it('home_security_events: rolling window AND a hard row cap', () => {
    const fetcher = security.slice(security.indexOf("table: 'home_security_events'"), security.indexOf('const [form'));
    expect(fetcher).toContain(".gte('occurred_at'");
    expect(fetcher).toMatch(/\.limit\(1000\)/);
    expect(fetcher).toContain('Date.now()');
  });

  it('experience_audits: rolling window AND a hard row cap', () => {
    const fetcher = scorecard.slice(scorecard.indexOf("table: 'experience_audits'"), scorecard.indexOf("table: 'experience_audits'") + 800);
    expect(fetcher).toContain(".gte('audited_on'");
    expect(fetcher).toMatch(/\.limit\(1000\)/);
    expect(fetcher).toContain('Date.now()');
  });

  // PLA-0814: next-actions pushed its 45-day horizon into the calendar_events query
  // instead of loading the family's full calendar history and filtering client-side.
  it('next-actions calendar_events: bounded by an upcoming date window + cap', () => {
    const fetcher = nextActions.slice(nextActions.indexOf("table: 'calendar_events'"), nextActions.indexOf("table: 'calendar_events'") + 700);
    expect(fetcher).toContain(".gte('starts_at'");
    expect(fetcher).toContain(".lte('starts_at'");
    expect(fetcher).toMatch(/\.limit\(500\)/);
  });

  it('briefing calendar_events: counted reads stay within the family day without truncating it', async () => {
    const fetcher = between(briefing, "table: 'calendar_events'", 'const { data: rawReminders');
    expect(fetcher).toContain('readCalendarOccurrences(sb, familyId,');
    expect(fetcher).toContain('briefingCalendarBounds(today, familyClock.timeZone, 0, 1)');

    const db = createInMemorySupabase({ maxRows: 100 });
    const today = Array.from({ length: 201 }, (_, i) => ({
      id: `today-${String(i).padStart(3, '0')}`, family_id: 'family',
      starts_at: '2026-10-07T18:00:00.000Z', ends_at: null, all_day: false,
      recurrence: 'none', recurrence_until: null,
    }));
    db.seed('calendar_events', [
      ...today,
      { ...today[0], id: 'prior-day', starts_at: '2026-10-07T06:59:59.999Z' },
      { ...today[0], id: 'next-day', starts_at: '2026-10-08T07:00:00.000Z' },
      { ...today[0], id: 'foreign-family', family_id: 'other' },
    ]);
    const result = await readCalendarOccurrences(db as unknown as SupabaseClient<Database>, 'family',
      briefingCalendarBounds('2026-10-07', 'America/Los_Angeles', 0, 1), 'America/Los_Angeles');
    expect(result.error).toBeNull();
    expect(result.data?.map(row => row.id)).toEqual(today.map(row => row.id));
  });

  it('an oversized briefing day fails instead of loading unbounded history or returning a prefix', async () => {
    const db = createInMemorySupabase({ maxRows: 100 });
    db.seed('calendar_events', Array.from({ length: 20_001 }, (_, i) => ({
      id: `event-${i}`, family_id: 'family', starts_at: '2026-10-07T18:00:00.000Z',
      ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null,
    })));
    const result = await readCalendarOccurrences(db as unknown as SupabaseClient<Database>, 'family',
      briefingCalendarBounds('2026-10-07', 'America/Los_Angeles', 0, 1), 'America/Los_Angeles');
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('More than 20000');
  });
});
