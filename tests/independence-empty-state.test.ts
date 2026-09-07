import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

const independenceView = readUiSource('components/modules/independence-module.tsx');

describe('independence empty state', () => {
  it('describes the empty badge collection without roadmap language', () => {
    expect(independenceView).toContain('No badges yet');
    expect(independenceView).not.toContain('First badge coming soon');
  });
});
