import { describe, it, expect } from 'vitest';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';

const base: HomeNeedsInput = {
  approvals: [], renewals: [], documents: [], conflicts: [],
  pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
  pendingChores: 0, lowGrocery: false, openTodos: 0, now: new Date('2026-06-28T12:00:00Z'),
};

describe('buildHomeNeeds', () => {
  it('returns nothing when nothing is pending', () => {
    expect(buildHomeNeeds(base)).toEqual([]);
  });

  it('unions every domain into one list with the right kinds', () => {
    const out = buildHomeNeeds({
      ...base,
      approvals: [{ id: 'a1', kind: 'card_spend', amount_cents: 2500, created_at: 'x' }],
      renewals: [{ id: 'r1', title: 'Rego', expires_at: '2026-06-29T12:00:00Z', reminder_days: 30, status: 'active' }],
      documents: [{ id: 'd1', title: 'Passport', expires_at: '2026-06-30T12:00:00Z' }],
      conflicts: [{ id: 'c1', assigneeName: 'Sam', count: 2, startsAt: '2026-06-28T15:00:00Z' }],
      pendingApprovals: 1, overdueReminders: 3, pendingChores: 2, lowGrocery: true, openTodos: 4,
    });
    const kinds = out.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      'approval', 'renewal', 'document', 'calendar_conflict', 'chore_signoff', 'reminder_overdue', 'chores_todo', 'grocery', 'todos',
    ]));
    expect(out.find((n) => n.kind === 'calendar_conflict')!.title).toBe('Sam: 2 events overlap');
  });

  it('shows overdue reminders OR due-today, never both', () => {
    const overdue = buildHomeNeeds({ ...base, overdueReminders: 2, dueTodayReminders: 5 });
    expect(overdue.map((n) => n.kind)).toContain('reminder_overdue');
    expect(overdue.map((n) => n.kind)).not.toContain('reminder_today');

    const today = buildHomeNeeds({ ...base, overdueReminders: 0, dueTodayReminders: 5 });
    expect(today.map((n) => n.kind)).toContain('reminder_today');
  });
});
