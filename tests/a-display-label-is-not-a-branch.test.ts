// Display copy is not a machine value.
//
// Four places in this repository asked "is this today?" by comparing a string
// that exists to be READ BY A HUMAN:
//
//   components/modules/locator-module.tsx  day.label === 'Today'
//   app/(app)/home/page.tsx                due === 'Today'
//   mobile/src/lib/format.ts               label === 'Today'   (twice)
//   lib/onboarding/first-brief.ts          first.timeLabel !== 'All day'
//
// Each one is correct in en-US and each one is a trap, because the repository's
// largest open finding (C2-M03) is the work that translates exactly these
// labels against an eleven-locale catalogue. On the day that lands, the locator
// stops rendering its today rail, the home page's amber "due today" badge goes
// grey, the onboarding brief starts saying "at All day", and — worst — every
// mobile item due later TODAY starts reading "Overdue".
//
// What makes it worth a guard rather than four edits is where the existing
// tests sit. `tests/location-overview.test.ts` pins `days[0].label` to
// 'Today'; `tests/mobile-core.test.ts` pins `dueLabel(...)` to its English
// output. Both live on the PRODUCER side of the seam. Translate the label and
// they go red, someone updates the expected strings, and the four CONSUMERS
// stay green while silently changing behaviour. The suite would report the
// regression as fixed.
//
// So the rule is about the shape, not the words: a branch asks the structured
// field, never the rendered one. This repository already knows how — see
// `lib/chores/dashboard.ts`, whose `dueLabel()` returns `{ label, tone }` with
// `tone` as the machine field, and `lib/concierge/digest.ts`, which persists
// `dayOffset` facts and treats the English text purely as a staleness check
// while `digest-display.ts` localises from the facts. Audit C1-S8-01.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['app', 'components', 'lib', 'mobile/src'];

// Labels this codebase renders and has a catalogue key (or a boolean) for.
const LABELS = [
  'Today', 'Yesterday', 'Tomorrow', 'All day', 'Overdue', 'No due date',
  'just now', 'In progress',
];

const COMPARISON = new RegExp(
  `(===|!==|==(?!=)|!=(?!=))\\s*(['"\`])(${LABELS.join('|')})\\2`
  + `|(['"\`])(${LABELS.join('|')})\\4\\s*(===|!==|==(?!=)|!=(?!=))`,
);

/** Strip line comments, block comments and JSX comments so prose about the rule
 *  cannot trip the rule — the mistake that made C2-S5-01's guard vacuous was
 *  the mirror image of this: matching text that was never code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', ...DIRS], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter((f) => /\.tsx?$/.test(f));
}

function offenders(files: string[]): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    const lines = stripComments(readFileSync(path.join(ROOT, rel), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (COMPARISON.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('a display label is not a branch', () => {
  it('scans a real, non-trivial set of files', () => {
    // A scanner that silently matches nothing passes forever. C4-S5-01's whole
    // finding was guards that could not fail, so this one states its own scope.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(1500);
    expect(files.some((f) => f === 'components/modules/locator-module.tsx')).toBe(true);
    expect(files.some((f) => f === 'mobile/src/lib/format.ts')).toBe(true);
  });

  it('still catches an offender when one is planted', () => {
    // The mutation, run in-process: if the pattern no longer fires on the exact
    // code that was removed from these four files, the guard is decorative.
    const planted = [
      "  if (day.label === 'Today') return render();",
      '  const overdue = label !== "Today" && past;',
      '  return first.timeLabel !== `All day` ? x : y;',
      "  if ('Tomorrow' === due) highlight();",
    ];
    for (const line of planted) expect(COMPARISON.test(stripComments(line))).toBe(true);
  });

  it('does not fire on the structured forms the codebase should be using', () => {
    const fine = [
      '  if (day.isToday) return render();',
      "  if (tone === 'today') highlight();",
      '  if (source.dueLabel !== item.dueLabel) return null;',
      "  return { label: 'Today', tone: 'today' };",
      "  timeLabel: e.allDay ? 'All day' : fmtTime(e.start),",
      "  // day.label === 'Today' is exactly what this rule forbids",
      "  /* label === 'Overdue' */",
    ];
    for (const line of fine) expect(COMPARISON.test(stripComments(line))).toBe(false);
  });

  it('finds no branch anywhere in app/, components/, lib/ or mobile/src that compares against rendered copy', () => {
    expect(offenders(sourceFiles())).toEqual([]);
  });
});
