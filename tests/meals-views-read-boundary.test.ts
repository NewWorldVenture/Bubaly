import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-10 — the Nutrition Tracker and Family Favorites views consume useRealtimeQuery
// but previously dropped its `error`, so a genuine (non-missing-table, online)
// read failure rendered as a silent empty list. They must surface a retryable
// ErrorState like the sibling Meals/Grocery/Pantry modules do.
const nutrition = readFileSync('components/meals/nutrition-view.tsx', 'utf8');
const favorites = readFileSync('components/meals/favorites-view.tsx', 'utf8');

describe('nutrition-view surfaces read failures', () => {
  it('destructures error + refresh from the realtime query', () => {
    expect(nutrition).toMatch(/const \{ data: rows, loading, error, refresh \} = useRealtimeQuery/);
  });
  it('renders a retryable ErrorState on error', () => {
    expect(nutrition).toContain('if (error) return <ErrorState');
    expect(nutrition).toContain('onRetry={refresh}');
  });
});

describe('favorites-view surfaces read failures', () => {
  it('destructures error + refresh from the realtime query', () => {
    expect(favorites).toMatch(/const \{ data: rows, loading, error, refresh \} = useRealtimeQuery/);
  });
  it('renders a retryable ErrorState on error', () => {
    expect(favorites).toContain('if (error) return <ErrorState');
    expect(favorites).toContain('onRetry={refresh}');
  });
});
