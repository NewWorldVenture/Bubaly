import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/modules/connections-module.tsx', 'utf8');

describe('connections UI integration boundary', () => {
  it('does not mark a provider connected from an account label alone', () => {
    expect(source).not.toMatch(/family_connections['"`]\)\.upsert/);
    expect(source).not.toMatch(/setConnecting\(/);
    expect(source).not.toMatch(/<Modal/);
  });

  it('routes implemented providers into the real sync setup surface', () => {
    expect(source).toContain("/dashboard/sync/accounts/${p.syncProvider}");
    expect(source).toContain('Open secure setup');
    expect(source).toContain('Live connection setup unavailable');
  });

  it('surfaces connection read failures instead of rendering every provider as disconnected', () => {
    expect(source).toContain('data: rows, loading, error, refresh');
    expect(source).toContain('Could not load your connections. Refresh and try again.');
    expect(source).toContain('onRetry={refresh}');
  });
});

