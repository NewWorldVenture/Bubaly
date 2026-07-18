import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 7 — M-006 completion): a search box should ask
// the mobile keyboard for the "Search" action key. We add `inputMode="search"` +
// `enterKeyHint="search"` (keeping `type="text"` so no duplicate native clear-× is
// drawn next to the modules' own clear buttons). This guard keeps the confirmed
// search boxes on the search keyboard.

const files = [
  'components/modules/files-hub-module.tsx',
  'components/modules/knowledge-base-module.tsx',
  'components/modules/weather-module.tsx',
  'components/modules/photos-module.tsx',
  'components/modules/social-feed-module.tsx',
  'components/modules/front-desk-module.tsx',
  'components/modules/inbox-module.tsx',
  'components/modules/shopping-module.tsx',
  'components/modules/marketplace-module.tsx',
  'components/modules/recipes-module.tsx',
];

describe('search inputs request the mobile search keyboard (M-006)', () => {
  for (const f of files) {
    it(`${f.split('/').pop()} search box has inputMode="search"`, () => {
      expect(fs.readFileSync(f, 'utf8')).toContain('inputMode="search"');
    });
  }
});
