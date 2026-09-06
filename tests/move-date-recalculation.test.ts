import { describe, expect, it } from 'vitest';
import {
  addMoveDays, isMoveDate, isMoveDatePreview, isMoveDateResult, moveDateContextKey, sameMoveDatePreview,
  type MoveDatePreview,
} from '@/lib/moving/recalculation';

const preview = (): MoveDatePreview => ({
  version: 1, familyId: '00000000-0000-0000-0000-000000000001', moveId: '00000000-0000-0000-0000-000000000002',
  memberId: '00000000-0000-0000-0000-000000000003', fromDate: '2026-10-31', toDate: '2026-11-07',
  moveUpdatedAt: '2026-09-06T06:00:00.000Z', changes: 1,
  tasks: [{
    id: '00000000-0000-0000-0000-000000000004', title: 'Book the truck', status: 'todo', mode: 'relative',
    offsetDays: -7, dueDate: '2026-10-24', nextDueDate: '2026-10-31', updatedAt: '2026-09-06T06:00:00+00:00',
    action: 'shift', reason: 'relative',
  }],
});

describe('move date calendar arithmetic', () => {
  it.each(['2026-09-06', '2028-02-29', '0001-01-01', '9999-12-31'])('accepts the real calendar date %s', (date) => {
    expect(isMoveDate(date)).toBe(true);
  });
  it.each(['2026-02-29', '2026-04-31', '0000-01-01', '2026-1-01', '2026-09-06T00:00:00Z', '', '2026-13-01', null])('rejects %s', (date) => {
    expect(isMoveDate(date)).toBe(false);
  });
  it.each([
    ['2026-11-01', 1, '2026-11-02'], ['2026-03-08', 1, '2026-03-09'],
    ['2028-03-01', -1, '2028-02-29'], ['2026-01-01', -1, '2025-12-31'],
  ])('adds calendar days without timezone drift', (date, days, expected) => {
    expect(addMoveDays(String(date), Number(days))).toBe(expected);
  });
  it('refuses unsupported years, invalid input and offsets', () => {
    expect(addMoveDays('9999-12-31', 1)).toBeNull();
    expect(addMoveDays('0001-01-01', -1)).toBeNull();
    expect(addMoveDays('2026-02-30', 1)).toBeNull();
    expect(addMoveDays('2026-01-01', 0.5)).toBeNull();
    expect(addMoveDays('2026-01-01', 366)).toBeNull();
    expect(addMoveDays('2026-01-01', Number.NaN)).toBeNull();
  });
});

describe('reviewed move date evidence', () => {
  it('accepts a scoped complete preview and a zero-task date-only review', () => {
    expect(isMoveDatePreview(preview())).toBe(true);
    expect(isMoveDatePreview({ ...preview(), tasks: [], changes: 0 })).toBe(true);
  });
  it('accepts fixed and completed tasks only with preserved dates', () => {
    const fixed = preview();
    fixed.changes = 0;
    Object.assign(fixed.tasks[0], { mode: 'fixed', action: 'preserve', reason: 'fixed', nextDueDate: fixed.tasks[0].dueDate });
    expect(isMoveDatePreview(fixed)).toBe(true);
    Object.assign(fixed.tasks[0], { status: 'done', reason: 'completed' });
    expect(isMoveDatePreview(fixed)).toBe(true);
  });
  it('preserves an explicitly missing deadline', () => {
    const value = preview();
    value.changes = 0;
    Object.assign(value.tasks[0], { dueDate: null, nextDueDate: null, action: 'preserve', reason: 'no_date' });
    expect(isMoveDatePreview(value)).toBe(true);
  });
  it.each([
    { changes: 0 }, { fromDate: '2026-02-30' }, { toDate: '2026-10-31' }, { familyId: 'someone' },
    { moveUpdatedAt: 'yesterday' }, { unexpected: true }, { version: 2 },
  ])('rejects malformed or incomplete preview metadata %j', (change) => {
    expect(isMoveDatePreview({ ...preview(), ...change })).toBe(false);
  });
  it.each([
    { status: 'done' }, { status: 'skipped' }, { mode: 'fixed' }, { nextDueDate: '2026-11-01' },
    { dueDate: '2026-10-25' }, { offsetDays: 366 }, { offsetDays: 0.1 }, { reason: 'fixed' },
    { action: 'preserve' }, { dueDate: null }, { nextDueDate: null }, { extra: 'unreviewed' },
  ])('rejects a fabricated or inconsistent shift %j', (change) => {
    const value = preview();
    value.tasks[0] = { ...value.tasks[0], ...change } as typeof value.tasks[0];
    expect(isMoveDatePreview(value)).toBe(false);
  });
  it('refuses duplicate, unsorted and over-limit task evidence', () => {
    const value = preview();
    expect(isMoveDatePreview({ ...value, tasks: [value.tasks[0], value.tasks[0]], changes: 2 })).toBe(false);
    const earlier = { ...value.tasks[0], id: '00000000-0000-0000-0000-000000000000' };
    expect(isMoveDatePreview({ ...value, tasks: [value.tasks[0], earlier], changes: 2 })).toBe(false);
    expect(isMoveDatePreview({ ...value, tasks: Array(1001).fill(value.tasks[0]), changes: 1001 })).toBe(false);
  });
  it('requires a persisted receipt only for an applied result', () => {
    expect(isMoveDateResult({ preview: preview(), applied: false, requestId: null, appliedAt: null })).toBe(true);
    expect(isMoveDateResult({ preview: preview(), applied: true, requestId: '00000000-0000-0000-0000-000000000009', appliedAt: '2026-09-06T06:01:00Z' })).toBe(true);
    expect(isMoveDateResult({ preview: preview(), applied: true, requestId: null, appliedAt: null })).toBe(false);
    expect(isMoveDateResult({ preview: preview(), applied: false, requestId: '00000000-0000-0000-0000-000000000009', appliedAt: null })).toBe(false);
  });
  it('compares full evidence independent of object property order, not changed values', () => {
    const first = preview();
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as MoveDatePreview;
    expect(sameMoveDatePreview(first, reordered)).toBe(true);
    expect(sameMoveDatePreview(first, { ...first, moveUpdatedAt: '2026-09-06T06:02:00Z' })).toBe(false);
    expect(sameMoveDatePreview(first, { ...first, tasks: [{ ...first.tasks[0], title: 'Changed title' }] })).toBe(false);
  });
  it('isolates household, user, member, role and active status in the UI key', () => {
    const context = { familyId: 'family', userId: 'user', memberId: 'member', role: 'parent', active: true };
    for (const delta of [{ familyId: 'other' }, { userId: 'other' }, { memberId: 'other' }, { role: 'child' }, { active: false }]) {
      expect(moveDateContextKey({ ...context, ...delta })).not.toBe(moveDateContextKey(context));
    }
  });
});
