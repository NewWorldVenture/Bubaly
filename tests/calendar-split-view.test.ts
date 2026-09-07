import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

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
