import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

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

  it('briefing calendar_events: bounded to a small window around today', () => {
    const fetcher = briefing.slice(briefing.indexOf("table: 'calendar_events'"), briefing.indexOf("table: 'calendar_events'") + 700);
    expect(fetcher).toContain(".gte('starts_at'");
    expect(fetcher).toContain(".lte('starts_at'");
    expect(fetcher).toMatch(/\.limit\(200\)/);
  });
});
