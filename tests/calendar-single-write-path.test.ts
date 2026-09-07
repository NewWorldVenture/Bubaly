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
 * `routines-panel` used to be the exception here: it materialises a whole
 * routine into a week — many rows in one insert, with an undo that deletes them
 * by id — and `createEvent` creates one event, so it needed a service change
 * rather than a call-site one. That change landed (`createEvents`/`deleteEvents`),
 * and this list is now empty. It is kept, rather than deleted, so a new direct
 * writer has somewhere to be declared instead of appearing unremarked.
 */
const KNOWN_REMAINING: string[] = [];

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

  it('the relationship page puts a date on the calendar through the service too', () => {
    // Not part of the calendar page, but a `calendar_events` writer all the same
    // — and it had the sharper bug: it deleted the event and cleared
    // `calendar_event_id` REGARDLESS, so a failed delete orphaned the event.
    const src = code('components/modules/relationship-module.tsx');
    expect(writesIn('components/modules/relationship-module.tsx')).toEqual([]);
    expect(src).toMatch(/from '@\/app\/\(app\)\/dashboard\/relationship\/actions'/);
  });

  it('has no calendar component left writing from the browser', () => {
    // Every entry must still actually write, so a converted file cannot sit here
    // pretending to be pending work — the same honesty the silent-empty ratchet
    // keeps about its own baseline.
    for (const file of KNOWN_REMAINING) {
      expect(writesIn(file).length, file).toBeGreaterThan(0);
    }
    expect(KNOWN_REMAINING).toHaveLength(0);
  });

  it('routines-panel applies and undoes a week through the service', () => {
    const src = code('components/modules/routines-panel.tsx');
    expect(writesIn('components/modules/routines-panel.tsx')).toEqual([]);
    expect(src).toMatch(/applyRoutineToCalendarAction\(/);
    expect(src).toMatch(/undoCalendarEventsAction\(/);
    // Undo drops the composition key, so applying again after changing their
    // mind is a new batch rather than being answered with deleted events.
    expect(src).toMatch(/delete applyIds\.current\[key\]/);
  });
});
