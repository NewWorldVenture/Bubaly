import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maintenanceCompletionPatch, maintenanceRepeats, nextMaintenanceDueAt } from '@/lib/home/maintenance-rollover';
import { nextRemindAt } from '@/lib/reminders/details';
import { bodyOf } from './helpers/source-order';

/**
 * A REPEATING MAINTENANCE TASK WAS DONE ONCE AND NEVER ASKED FOR AGAIN.
 *
 * `maintenance_tasks` carries `interval_days` ("HVAC filter every 90 days",
 * 0002_tables.sql) and a `recurrence`. The Home service, the assistant's home
 * tool and the emergency-prep plan template all set an interval (smoke alarms
 * every 180 days). The Home module's "complete" wrote `status: 'done'` for
 * every task alike, and every open-task reader — the module itself, the brief,
 * the briefing API, the operating index, the insights — selects
 * `status in ('todo', 'in_progress')`. So a repeating task was one row that
 * closed the first time anyone ticked it.
 *
 * The fix is one pure decision, `maintenanceCompletionPatch`: a repeating task
 * rolls to its next due time and stays open, with `completed_at` recording
 * when it was last done; a one-off is done as before. Two readers that
 * filtered `completed_at is null` as a second "open" test would have hidden
 * every rolled task after its first completion; they now trust `status`.
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = '2026-10-03T09:00:00.000Z';

describe('maintenanceRepeats', () => {
  it('an interval or a calendar cadence repeats; nothing else does', () => {
    expect(maintenanceRepeats({ due_at: null, interval_days: 90 })).toBe(true);
    expect(maintenanceRepeats({ due_at: null, interval_days: null, recurrence: 'yearly' })).toBe(true);
    expect(maintenanceRepeats({ due_at: null, interval_days: null, recurrence: 'none' })).toBe(false);
    expect(maintenanceRepeats({ due_at: null, interval_days: null })).toBe(false);
    expect(maintenanceRepeats({ due_at: null, interval_days: 0, recurrence: 'none' })).toBe(false);
    expect(maintenanceRepeats({ due_at: null, interval_days: -7, recurrence: 'none' })).toBe(false);
  });
});

describe('nextMaintenanceDueAt', () => {
  it('done early, the schedule keeps its date: the next one is an interval after the due time', () => {
    expect(nextMaintenanceDueAt({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 180 }, NOW)).toBe('2027-04-08T10:00:00.000Z');
  });
  it('done late, the next one is an interval after the day it was actually done', () => {
    expect(nextMaintenanceDueAt({ due_at: '2026-09-01T10:00:00.000Z', interval_days: 90 }, NOW)).toBe('2027-01-01T09:00:00.000Z');
  });
  it('a repeating task with no due time is due an interval from now', () => {
    expect(nextMaintenanceDueAt({ due_at: null, interval_days: 30 }, NOW)).toBe('2026-11-02T09:00:00.000Z');
  });
  it('a calendar cadence steps the way a recurring reminder does, from the same anchor rule', () => {
    const due = '2026-10-10T10:00:00.000Z';
    expect(nextMaintenanceDueAt({ due_at: due, interval_days: null, recurrence: 'monthly' }, NOW)).toBe(nextRemindAt(due, 'monthly'));
    // Overdue: stepped from now, not from the missed date.
    const late = nextMaintenanceDueAt({ due_at: '2026-01-10T10:00:00.000Z', interval_days: null, recurrence: 'yearly' }, NOW);
    expect(late).toBe(nextRemindAt(NOW, 'yearly'));
  });
  it('an interval wins over a cadence when both are set', () => {
    expect(nextMaintenanceDueAt({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 7, recurrence: 'yearly' }, NOW)).toBe('2026-10-17T10:00:00.000Z');
  });
  it('a one-off, an unknown cadence, or an unreadable now gives nothing to roll to', () => {
    expect(nextMaintenanceDueAt({ due_at: '2026-10-10T10:00:00.000Z', interval_days: null, recurrence: 'none' }, NOW)).toBeNull();
    expect(nextMaintenanceDueAt({ due_at: '2026-10-10T10:00:00.000Z', interval_days: null, recurrence: 'sometimes' }, NOW)).toBeNull();
    expect(nextMaintenanceDueAt({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 90 }, 'now')).toBeNull();
  });
});

describe('maintenanceCompletionPatch — what "complete" writes', () => {
  it('a repeating task stays open on its next due time and records when it was last done', () => {
    expect(maintenanceCompletionPatch({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 180 }, NOW))
      .toEqual({ status: 'todo', due_at: '2027-04-08T10:00:00.000Z', completed_at: NOW });
  });
  it('a one-off is done', () => {
    expect(maintenanceCompletionPatch({ due_at: '2026-10-10T10:00:00.000Z', interval_days: null, recurrence: 'none' }, NOW))
      .toEqual({ status: 'done', completed_at: NOW });
  });
});

describe('the Home module writes the patch, and the open-task readers trust status', () => {
  it('completeTask', () => {
    const src = read('components/modules/home-module.tsx');
    expect(src).toContain("import { maintenanceCompletionPatch } from '@/lib/home/maintenance-rollover';");
    const body = bodyOf(src, 'async function completeTask(id: string) {', "success(tr('homeModule.taskCompleted'));");
    expect(body).toContain('maintenanceCompletionPatch(task, now)');
    expect(body).toContain(".update(patch).eq('id', id).select('id')");
    expect(body, 'the flat done write is gone').not.toContain("status: 'done', completed_at: new Date().toISOString(),");
  });
  it.each([
    ['lib/briefing/deliver.ts', ".not('due_at', 'is', null)"],
    ['app/api/ai/briefing/route.ts', ".not('due_at', 'is', null)"],
  ])('%s reads open maintenance by status alone', (file, end) => {
    const src = read(file);
    const readMaint = bodyOf(src, "from('maintenance_tasks').select('title, due_at, status, completed_at')", end);
    expect(readMaint).toContain("in('status', ['todo', 'in_progress'])");
    expect(readMaint, 'a rolled task has a completed_at and is still open').not.toContain("is('completed_at', null)");
  });
});
