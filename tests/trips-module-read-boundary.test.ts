import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-13 — the Trips module runs two realtime queries: `trips` (gated with an
// ErrorState) and `trip_items` (the packing/todo checklist shown per trip).
// The trip_items read previously dropped its `error`, so a genuine
// (non-missing-table, online) failure rendered the detail view as an empty
// 0%-progress checklist with no error and no retry — the user's checklist items
// silently vanish. Both reads must fold into the same retryable ErrorState.
const src = readFileSync('components/modules/trips-module.tsx', 'utf8');

describe('trips-module surfaces the trip_items read failure', () => {
  it('captures error + refresh from BOTH realtime queries', () => {
    expect(src).toMatch(/const \{ data: trips, loading, error, refresh: refreshTrips \} = useRealtimeQuery/);
    expect(src).toMatch(/const \{ data: items, error: itemsError, refresh: refreshItems \} = useRealtimeQuery/);
  });

  it('gates the view on either read failing, with a retry', () => {
    expect(src).toContain('const loadError = error || itemsError');
    expect(src).toContain('if (loadError) return <ErrorState');
    expect(src).toMatch(/onRetry=\{\(\) => \{ refreshTrips\(\); refreshItems\(\); \}\}/);
  });
});
