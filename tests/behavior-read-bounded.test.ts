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
});
