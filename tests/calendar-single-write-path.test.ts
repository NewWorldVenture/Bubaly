// One door into `calendar_events`, and a list of what is still outside it.
//
// The behavioural proofs in `calendar-write-path.test.ts` say the server action
// is right. They cannot say the modal calls it — a client component with hooks
// does not render under `environment: 'node'`, and a passing action is exactly
// what a component that still writes straight to PostgREST would leave behind.
//
// So this is a structural property, and a structural test is the right shape for
// it: no client component in the calendar surface may reach `calendar_events`
// with a write. That is not an ordering claim dressed up as a source scan — it
// is a claim about which module holds the write, which is precisely what the
// source says.
//
// The exceptions are enumerated rather than pattern-matched, so §7's remaining
// calendar work is a list somebody chose instead of a list nobody counted.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The components that make up the calendar surface a family touches. */
const SURFACE = [
  'components/modules/calendar-module.tsx',
  'components/modules/find-time-modal.tsx',
  'components/modules/event-detail-modal.tsx',
];

/**
 * Still writing `calendar_events` from the browser, deliberately, for now.
 *
 * `routines-panel` materialises a whole routine into a week — many rows in one
 * insert, with an undo that deletes them by id. `createEvent` creates one event,
 * so routing this through it is a service change (a batch create that is
 * idempotent as a batch), not a call-site change, and bundling it here would
 * make this commit two things.
 */
const KNOWN_REMAINING = ['components/modules/routines-panel.tsx'];

/** `.from('calendar_events')` followed by a write verb, allowing whitespace and chained calls. */
const WRITE = /\.from\(\s*['"]calendar_events['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\s*\(/g;

/**
 * Comments out, code in. A file explaining what it no longer does will name the
 * call it no longer makes, and this test was failing on its own explanation
 * before it was failing on anything real.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

function writesIn(file: string): string[] {
  return [...code(file).matchAll(WRITE)].map((m) => m[1]!);
}

describe('the calendar surface writes through the service', () => {
  it.each(SURFACE)('%s issues no direct write to calendar_events', (file) => {
    expect(writesIn(file)).toEqual([]);
  });

  it.each(SURFACE)('%s reaches the calendar through the server action instead', (file) => {
    const src = code(file);
    expect(src).toMatch(/from '@\/app\/\(app\)\/dashboard\/calendar\/actions'/);
  });

  it('mints a submission id for every create it makes', () => {
    // A create with no id degrades to today's un-deduplicated write, which is the
    // right failure mode but the wrong default — a create call site that forgets
    // the id reopens the gap silently, with every test still green.
    for (const file of SURFACE) {
      const src = code(file);
      const creates = (src.match(/createCalendarEventAction\(/g) ?? []).length;
      if (creates === 0) continue;
      expect(src, file).toMatch(/from '@\/lib\/utils\/submission-id'/);
      expect((src.match(/submissionId:/g) ?? []).length, file).toBe(creates);
    }
  });

  it('names the one calendar component that still writes from the browser', () => {
    // Fails the day routines-panel is converted, which is the point: the list
    // has to be edited deliberately rather than drifting out of date.
    for (const file of KNOWN_REMAINING) {
      expect(writesIn(file).length, file).toBeGreaterThan(0);
    }
    expect(KNOWN_REMAINING).toHaveLength(1);
  });
});
