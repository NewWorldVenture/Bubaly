import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';
import ts from 'typescript';
import { wallFromKey, wallMonthStart, wallWeekStart, wallKey, wallParts, addWallDays } from '@/lib/time/wall-clock';

// A-06 calendar (direct user request): two guarantees.
//  1. The mini-calendar's purple "selected" block must track the FOCUSED day
//     (days[mobileDayIndex]) — the day the user is actually looking at — not the
//     week's Monday. It previously passed `current={monday}`, so on any day other
//     than Monday the highlight lied (e.g. showed the 13th while today was the 18th).
//  2. Opt-in "Side-by-side view" splits the focused day into one column per visible
//     member, each showing that member's events plus shared/family events, so a
//     family can compare everyone's day at a glance.

const src = readUiSource('components/modules/calendar-module.tsx');

describe('calendar mini-calendar highlights the focused day (A-06)', () => {
  it('MiniCalendar receives the focused day, not the week Monday', () => {
    expect(src).toContain('<MiniCalendar current={days[mobileDayIndex]}');
    // Guard against the regressed form.
    expect(src).not.toContain('<MiniCalendar current={monday}');
  });

  it('selecting a mini-calendar day updates both the week and the focused day index', () => {
    const call = src.slice(src.indexOf('<MiniCalendar'), src.indexOf('<MiniCalendar') + 400);
    expect(call).toContain('setWeekOffset(');
    expect(call).toContain('setMobileDayIndex(');
  });
});

describe('calendar side-by-side per-member view (A-06)', () => {
  it('exposes an opt-in Side-by-side view checkbox', () => {
    expect(src).toContain('splitByMember');
    expect(src).toContain('setSplitByMember(e.target.checked)');
    expect(src).toContain('Side-by-side view');
  });

  it('split columns are per visible member and merge own + shared events', () => {
    expect(src).toContain('const splitActive = splitByMember && visibleMembers.length > 0;');
    // Each member column includes events assigned to them OR unassigned (shared/family).
    expect(src).toContain('e.assignee_id === m.id || !e.assignee_id');
  });

  it('the grid iterates one unified column model for both day/week and split modes', () => {
    expect(src).toContain('gridCols.map((col)');
    // Header labels either a member (split) or a weekday date (normal).
    expect(src).toContain('col.member ?');
  });
});

// Execute the actual navigation declaration with synthetic state setters.
// The mounted browser regression separately exercises the complete component.
const calendarFile = fs.readFileSync('components/modules/calendar-module.tsx', 'utf8');
const calendarAst = ts.createSourceFile('calendar-module.tsx', calendarFile, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string): string {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(calendarAst);
  if (!found) throw new Error('Missing actual calendar declaration: ' + name);
  return ts.transpileModule(found.getText(calendarAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function navigation(day: string, view: 'day' | 'week' | 'month', dayIndex = 0) {
  const current = wallFromKey(day);
  let offset = 0;
  let focusedDay = dayIndex;
  const setters = [
    (update: number | ((value: number) => number)) => { offset = typeof update === 'function' ? update(offset) : update; },
    (update: number | ((value: number) => number)) => { focusedDay = typeof update === 'function' ? update(focusedDay) : update; },
  ];
  const nav = (dir: -1 | 1) => {
    const actual = new Function('view', 'monday', 'clock', 'setWeekOffset', 'setMobileDayIndex',
      'wallWeekStart', 'addWallDays', 'wallMonthStart', 'weeksBetween', 'weekStart',
      declaration('navStep') + '\nreturn navStep;')(
      view, wallWeekStart(current, offset), { wallNow: () => current }, ...setters,
      wallWeekStart, addWallDays, wallMonthStart,
      (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / (7 * 86400000)),
      wallWeekStart,
    ) as (dir: -1 | 1) => void;
    actual(dir);
  };
  return { nav, month: () => wallKey(wallMonthStart(wallWeekStart(current, offset))).slice(0, 7),
    week: () => wallKey(wallWeekStart(current, offset)), day: () => focusedDay };
}

describe('actual calendar navigation follows calendar months', () => {
  it.each([
    ['2026-03-02', 1, '2026-04'], ['2026-03-30', -1, '2026-02'],
    ['2026-12-07', 1, '2027-01'], ['2027-01-04', -1, '2026-12'],
    ['2024-01-29', 1, '2024-02'], ['2026-02-02', 1, '2026-03'],
    ['2026-05-04', -1, '2026-04'],
  ] as const)('month arrow from %s reaches the adjacent month', (day, dir, wanted) => {
    const calendar = navigation(day, 'month'); calendar.nav(dir); expect(calendar.month()).toBe(wanted);
  });
  it('repeated next and previous month controls return to the same displayed month', () => {
    const calendar = navigation('2026-03-02', 'month');
    calendar.nav(1); calendar.nav(1); expect(calendar.month()).toBe('2026-05');
    calendar.nav(-1); calendar.nav(-1); expect(calendar.month()).toBe('2026-03');
  });
  it('week arrows retain one-week movement', () => {
    const calendar = navigation('2026-03-02', 'week');
    calendar.nav(1); expect(calendar.week()).toBe('2026-03-09');
    calendar.nav(-1); expect(calendar.week()).toBe('2026-03-02');
  });
  it('day navigation still crosses both week boundaries', () => {
    const next = navigation('2026-03-02', 'day', 6);
    next.nav(1); expect(next.week()).toBe('2026-03-09'); expect(next.day()).toBe(0);
    const previous = navigation('2026-03-02', 'day', 0);
    previous.nav(-1); expect(previous.week()).toBe('2026-02-23'); expect(previous.day()).toBe(6);
  });
  it('mini-calendar weekday labels use the same Monday-first order as its date cells', () => {
    const mini = calendarFile.slice(calendarFile.indexOf('function MiniCalendar('), calendarFile.indexOf('// Full-month grid'));
    const labels = /\{\[(.*?)\]\.map\(\(d, i\)/.exec(mini)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1));
    expect(labels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect((wallParts(wallMonthStart(wallFromKey('2026-03-02'))).weekday + 6) % 7).toBe(6);
  });
});
