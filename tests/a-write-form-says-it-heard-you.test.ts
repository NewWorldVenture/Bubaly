import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Fifteen create/edit forms awaited a Supabase write with no pending state: a
// bare `<Button type="submit">` with neither `loading` nor `disabled`, and a
// handler with no re-entrance guard. Between the tap and the round trip, the
// button looked completely idle — so on a slow connection a parent taps "Log
// it", sees nothing, and taps again. Two behaviour logs, two immunisation
// records, two votes.
//
// The codebase already knew the pattern and applied it to the wrong button:
// four of these files declare `const [busy, setBusy] = useState(false)` and
// wire it to an AI-generate button while leaving the PRIMARY write bare.
//
// Two properties are pinned per form, and the second is the one that is easy to
// lose in a refactor:
//
//   1. the submit button reports pending, so it also goes `disabled`
//      (components/ui/button.tsx: `disabled={disabled || loading}`);
//   2. `e.preventDefault()` runs BEFORE the re-entrance guard. Returning first
//      would hand the form to the browser's native submission — a full page
//      navigation — which is worse than the double insert being prevented.

const FORMS: { file: string; handlers: [string, string][] }[] = [
  { file: 'components/modules/behavior-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/screen-time-module.tsx', handlers: [['save', 'saving'], ['saveLimit', 'savingLimit']] },
  { file: 'components/modules/binder-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/devices-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/health-visits-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/immunizations-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/security-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/subscriptions-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/utilities-module.tsx', handlers: [['save', 'saving']] },
  { file: 'components/modules/voting-module.tsx', handlers: [['createPoll', 'saving']] },
  { file: 'components/modules/weekend-module.tsx', handlers: [['addFeed', 'saving']] },
  { file: 'components/vacations/shared.tsx', handlers: [['save', 'saving']] },
  { file: 'components/vacations/trip-itinerary.tsx', handlers: [['saveItem', 'saving']] },
  { file: 'components/vacations/trip-packing.tsx', handlers: [['add', 'saving']] },
  { file: 'components/vacations/vacations-list.tsx', handlers: [['create', 'saving']] },
];

/**
 * Comments are prose, not control flow.
 *
 * This is not hypothetical tidiness: the ordering assertion below FIRST PASSED
 * ON BROKEN CODE. The handler's own comment contains the words
 * "preventDefault() stays ABOVE it", so `body.indexOf('preventDefault()')`
 * found the explanation rather than the call, and moving the real call below
 * the guard changed nothing the test could see. A guard that reads its own
 * documentation is not a guard.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The brace-matched body of `async function name(...)`. */
function bodyOf(source: string, name: string): string {
  const signature = new RegExp(`\\basync function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = source.match(signature);
  expect(m, `${name} was not found`).not.toBeNull();
  const start = source.indexOf(m![0]) + m![0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

describe('a form that writes says it heard you', () => {
  for (const { file, handlers } of FORMS) {
    const source = readFileSync(file, 'utf8');

    for (const [name, flag] of handlers) {
      it(`${file} — ${name} refuses a second submit`, () => {
        const body = bodyOf(source, name);
        expect(body, `${name} has no re-entrance guard`).toMatch(
          new RegExp(`if\\s*\\(${flag}\\)\\s*return;`),
        );
        expect(body).toContain(`set${flag[0].toUpperCase()}${flag.slice(1)}(true);`);
        // finally, not the happy path: an early `return` on a validation
        // failure must still clear the flag, or the form locks forever.
        expect(body, `${name} clears ${flag} outside a finally`).toMatch(
          /\} finally \{\s*set\w+\(false\);/,
        );
      });

      it(`${file} — ${name} calls preventDefault before the guard`, () => {
        const body = withoutComments(bodyOf(source, name));
        const prevent = body.indexOf('preventDefault()');
        const guard = body.indexOf(`if (${flag}) return;`);
        expect(prevent, `${name} never calls preventDefault`).toBeGreaterThan(-1);
        expect(
          prevent < guard,
          `${name} guards before preventDefault — a second submit would navigate the page`,
        ).toBe(true);
      });

      it(`${file} — ${name} declares its pending state`, () => {
        expect(source).toContain(`const [${flag}, set${flag[0].toUpperCase()}${flag.slice(1)}] = useState(false)`);
      });
    }

    it(`${file} — every submit button reports pending`, () => {
      const buttons = [...source.matchAll(/type="submit"[^>]*/g)].map((m) => m[0]);
      expect(buttons.length, `${file} has no submit button`).toBe(handlers.length);
      for (const button of buttons) {
        // `loading` is enough: components/ui/button.tsx sets
        // `disabled={disabled || loading}`, so the click is covered too.
        expect(button, `a submit button in ${file} is still bare`).toMatch(/loading=\{/);
      }
    });
  }
});
