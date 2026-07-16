import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const independenceView = readFileSync('components/modules/independence-module.tsx', 'utf8');

describe('independence empty state', () => {
  it('describes the empty badge collection without roadmap language', () => {
    expect(independenceView).toContain('No badges yet');
    expect(independenceView).not.toContain('First badge coming soon');
  });
});
