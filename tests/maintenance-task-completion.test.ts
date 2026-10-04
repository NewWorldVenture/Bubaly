import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  maintenanceCompletionPatch,
  maintenanceRepeats,
  nextMaintenanceDueAt,
  writeMaintenanceCompletion,
} from '@/lib/home/maintenance-rollover';
import { bodyOf } from './helpers/source-order';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const NOW = '2026-10-03T09:00:00.000Z';
type CompletionTask = Parameters<typeof writeMaintenanceCompletion>[2];

function task(overrides: Partial<CompletionTask> = {}): CompletionTask {
  return {
    id: 'maintenance-task-1',
    family_id: 'family-a',
    status: 'todo',
    recurrence: 'none',
    interval_days: null,
    due_at: null,
    completed_at: null,
    ...overrides,
  };
}

type Filter = { op: 'eq' | 'in' | 'is'; column: string; value: unknown };

function fakeDb(serverRow: CompletionTask) {
  const filters: Filter[] = [];
  let savedPatch: Partial<CompletionTask> = {};
  let selectedTable: string | null = null;
  let fromCalls = 0;
  const builder = {
    update(patch: Partial<CompletionTask>) { savedPatch = patch; return builder; },
    eq(column: string, value: unknown) { filters.push({ op: 'eq', column, value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ op: 'in', column, value }); return builder; },
    is(column: string, value: null) { filters.push({ op: 'is', column, value }); return builder; },
    async select() {
      const matches = filters.every((filter) => {
        const current = serverRow[filter.column as keyof CompletionTask];
        if (filter.op === 'eq') return current === filter.value;
        if (filter.op === 'is') return current === null;
        return (filter.value as unknown[]).includes(current);
      });
      if (!matches) return { data: [], error: null };
      Object.assign(serverRow, savedPatch);
      return { data: [{ id: serverRow.id }], error: null };
    },
  };
  const db = {
    from(tableName: string) { fromCalls += 1; selectedTable = tableName; return builder; },
  } as unknown as SupabaseClient<Database>;
  return { db, filters, get fromCalls() { return fromCalls; }, get selectedTable() { return selectedTable; } };
}

describe('maintenance recurrence', () => {
  it('recognizes positive integer intervals and supported calendar cadences', () => {
    expect(maintenanceRepeats(task({ interval_days: 90 }))).toBe(true);
    expect(maintenanceRepeats(task({ recurrence: 'yearly' }))).toBe(true);
    expect(maintenanceRepeats(task({ interval_days: 0, recurrence: 'none' }))).toBe(false);
    expect(maintenanceRepeats(task({ interval_days: 90.5, recurrence: 'none' }))).toBe(false);
    expect(maintenanceRepeats({ due_at: null, interval_days: null, recurrence: 'unsupported' })).toBe(false);
  });

  it('anchors early completion to the due date and overdue completion to now', () => {
    expect(nextMaintenanceDueAt(task({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 180 }), NOW))
      .toBe('2027-04-08T10:00:00.000Z');
    expect(nextMaintenanceDueAt(task({ due_at: '2026-09-01T10:00:00.000Z', interval_days: 90 }), NOW))
      .toBe('2027-01-01T09:00:00.000Z');
  });

  it('keeps the family wall-clock time across daylight-saving transitions', () => {
    // 9am in Los Angeles is 17:00Z before the spring transition and 16:00Z after it.
    expect(nextMaintenanceDueAt(
      task({ due_at: '2027-02-15T17:00:00.000Z', interval_days: 90 }),
      '2027-02-01T00:00:00.000Z',
      'America/Los_Angeles',
    )).toBe('2027-05-16T16:00:00.000Z');
    expect(nextMaintenanceDueAt(
      task({ due_at: '2027-02-15T17:00:00.000Z', recurrence: 'monthly' }),
      '2027-02-01T00:00:00.000Z',
      'America/Los_Angeles',
    )).toBe('2027-03-15T16:00:00.000Z');
  });

  it('clamps a month-end schedule to the next month length and then keeps that day', () => {
    const first = nextMaintenanceDueAt(
      task({ due_at: '2027-01-31T17:00:00.000Z', recurrence: 'monthly' }),
      '2027-01-01T00:00:00.000Z',
      'America/Los_Angeles',
    );
    expect(first).toBe('2027-02-28T17:00:00.000Z');
    expect(nextMaintenanceDueAt(
      task({ due_at: first, recurrence: 'monthly' }),
      '2027-02-01T00:00:00.000Z',
      'America/Los_Angeles',
    )).toBe('2027-03-28T16:00:00.000Z');
  });

  it('clamps leap day to February 28 in a non-leap year', () => {
    expect(nextMaintenanceDueAt(
      task({ due_at: '2028-02-29T17:00:00.000Z', recurrence: 'yearly' }),
      '2028-02-01T00:00:00.000Z',
      'America/Los_Angeles',
    )).toBe('2029-02-28T17:00:00.000Z');
  });

  it('leaves one-off tasks done and repeating tasks open at the next due time', () => {
    expect(maintenanceCompletionPatch(task({ recurrence: 'none' }), NOW))
      .toEqual({ status: 'done', completed_at: NOW });
    expect(maintenanceCompletionPatch(task({ due_at: '2026-10-10T10:00:00.000Z', interval_days: 7 }), NOW))
      .toEqual({ status: 'todo', due_at: '2026-10-17T10:00:00.000Z', completed_at: NOW });
  });
});

describe('family-scoped maintenance completion compare-and-set', () => {
  it('does not overwrite a concurrent cadence edit from a stale task card', async () => {
    const shown = task({ interval_days: 90, due_at: '2026-10-10T10:00:00.000Z' });
    const current = { ...shown, interval_days: 30 };
    const fake = fakeDb(current);

    const result = await writeMaintenanceCompletion(fake.db, 'family-a', shown, NOW, 'UTC');

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(current).toMatchObject({ status: 'todo', interval_days: 30, due_at: shown.due_at, completed_at: null });
    expect(fake.filters).toContainEqual({ op: 'eq', column: 'family_id', value: 'family-a' });
    expect(fake.filters).toContainEqual({ op: 'eq', column: 'interval_days', value: 90 });
  });

  it('writes a repeating completion for the same open family row', async () => {
    const current = task({ interval_days: 90, due_at: '2026-10-10T10:00:00.000Z' });
    const fake = fakeDb(current);

    const result = await writeMaintenanceCompletion(fake.db, 'family-a', current, NOW, 'UTC');

    expect(fake.selectedTable).toBe('maintenance_tasks');
    expect(result.data).toEqual([{ id: current.id }]);
    expect(current).toMatchObject({ status: 'todo', due_at: '2027-01-08T10:00:00.000Z', completed_at: NOW });
  });

  it('refuses a task snapshot from another family without issuing a query', async () => {
    const current = task({ family_id: 'family-b' });
    const fake = fakeDb(current);

    const result = await writeMaintenanceCompletion(fake.db, 'family-a', current, NOW, 'UTC');

    expect(result.data).toEqual([]);
    expect(fake.fromCalls).toBe(0);
    expect(current.status).toBe('todo');
  });
});

describe('maintenance readers and Home wiring', () => {
  it.each([
    ['app/api/ai/briefing/route.ts', "from('maintenance_tasks').select('title, due_at, status, completed_at')"],
    ['lib/briefing/deliver.ts', "db.from('maintenance_tasks').select('title, due_at, status, completed_at')"],
  ])('%s keeps an open recurring task visible after completion', (path, start) => {
    const source = read(path);
    const query = bodyOf(source, start, ".order('due_at').limit(20)");
    expect(query).toContain("in('status', ['todo', 'in_progress'])");
    expect(query).not.toContain("is('completed_at', null)");
  });

  it('routes the UI completion through a family-scoped schedule compare-and-set', () => {
    const source = read('components/modules/home-module.tsx');
    expect(source).toContain("import { writeMaintenanceCompletion } from '@/lib/home/maintenance-rollover';");
    const complete = bodyOf(source, 'async function completeTask(id: string) {', 'async function removeAsset(id: string) {');
    expect(complete).toContain('(tasks ?? []).find((item) => item.id === id)');
    expect(complete).toContain('task.family_id !== familyId');
    expect(complete).toContain('writeMaintenanceCompletion(');
    expect(complete).toContain('family.timezone || \'UTC\'');
  });
});
