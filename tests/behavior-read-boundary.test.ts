import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/modules/behavior-module.tsx', 'utf8');

describe('behavior read boundary', () => {
  it('surfaces behavior read failures before the empty state', () => {
    expect(source).toContain('error, refresh } = useRealtimeQuery');
    expect(source).toContain('Could not load behavior logs. Refresh and try again.');
    expect(source).toContain('onRetry={refresh}');
  });
});

