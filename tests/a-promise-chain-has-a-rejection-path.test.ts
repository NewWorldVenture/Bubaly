import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every client promise chain can fail out loud.
 *
 * `.then(onFulfilled)` with one argument and no `.catch()` has no rejection
 * path. supabase-js and the server actions REJECT on a transport failure (they
 * only *resolve* `{ ok: false }` for an answered request), so these chains
 * turned an outage into an unhandled rejection: a spinner that never cleared,
 * an Undo that looked done, a skeleton that never resolved, and no trace
 * anywhere.
 *
 * Three earlier passes fixed this in `meals-module`, `event-detail-modal`,
 * `quick-post` and `app-lock-settings` — each left a comment saying so. The fix
 * had not reached the rest. These are the ones it had not reached.
 */

const FIXED: { file: string; marker: RegExp; why: string }[] = [
  {
    file: 'components/settings/ai-settings.tsx',
    marker: /\[ai-settings\] load failed/,
    why: 'a rejection left the skeleton on screen forever',
  },
  {
    file: 'components/moments/moments-view.tsx',
    marker: /\[moments\] undo failed/,
    why: 'an Undo that looked done and was not',
  },
  {
    file: 'components/modules/routines-panel.tsx',
    marker: /\[routines\] undo failed/,
    why: 'the same Undo, with the events still on the calendar',
  },
  {
    file: 'components/modules/workload-module.tsx',
    marker: /\[workload\] snapshot save failed/,
    why: 'a weekly snapshot silently not saved',
  },
  {
    file: 'components/modules/social-feed-module.tsx',
    marker: /\[social-feed\] action failed/,
    why: 'the shared run() helper every control in the module goes through',
  },
  {
    file: 'components/modules/medical-records-module.tsx',
    marker: /\[medical-records\] card image could not be signed/,
    why: 'a blank insurance card that read as "never uploaded"',
  },
  {
    file: 'components/services/service-tooltip.tsx',
    marker: /\[service-tooltip\] overrides read failed/,
    why: 'cosmetic, but invisible when it breaks',
  },
  {
    file: 'components/app/free-tier-sidebar.tsx',
    marker: /\[sidebar\] preference read failed/,
    why: 'preferences silently replaced by defaults',
  },
];

describe('a rejected promise is reported, not dropped', () => {
  for (const { file, marker, why } of FIXED) {
    it(`${file.split('/').pop()}: ${why}`, () => {
      expect(readFileSync(file, 'utf8'), `${file} lost its rejection path`).toMatch(marker);
    });
  }

  it('the shared social-feed helper clears its busy state in a finally', () => {
    // The rejection used to skip setBusy(null) and leave the control disabled.
    const source = readFileSync('components/modules/social-feed-module.tsx', 'utf8');
    expect(source).toMatch(/finally \{\s*\n\s*setBusy\(null\);/);
  });

  it('a card image that could not be signed says so rather than looking absent', () => {
    const source = readFileSync('components/modules/medical-records-module.tsx', 'utf8');
    expect(source).toMatch(/failed \? t\('installButton\.unavailable'\) : label/);
  });
});
