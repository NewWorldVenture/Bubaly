import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-032: chat thread scrollers must contain overscroll. On Chrome Android,
// pulling down at the top of a nested scroller chains to the document and
// triggers pull-to-refresh — reloading the page and wiping the draft typed in
// the composer below. `overscroll-contain` on the thread scroller stops the
// chain (desktop/iOS unaffected).
const THREADS: Array<[string, string]> = [
  ['components/modules/messages-module.tsx', 'flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-1'],
  ['components/modules/assistant-module.tsx', 'mt-7 flex-1 space-y-6 overflow-y-auto overscroll-contain pb-4'],
  ['components/modules/concierge-module.tsx', 'flex-1 overflow-y-auto overscroll-contain space-y-4 pr-1'],
];

describe('chat thread scrollers contain overscroll (M-032)', () => {
  it('every draft-holding chat thread has overscroll-contain', () => {
    for (const [file, cls] of THREADS) {
      expect(readFileSync(file, 'utf8'), file).toContain(cls);
    }
  });
});
