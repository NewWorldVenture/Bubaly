import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/family/check-in-view.tsx', 'utf8');

describe('family check-in read boundary', () => {
  it('surfaces the safety feed read error before its empty state', () => {
    expect(source).toContain('error, refresh } = useRealtimeQuery');
    expect(source).toContain('Could not load family check-ins. Refresh and try again.');
    expect(source).toContain('onRetry={refresh}');
  });
});

