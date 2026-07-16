import { describe, it, expect } from 'vitest';
import { appleAdapter } from '@/lib/sync/providers/apple';
import { SyncApiError } from '@/lib/sync/adapter';

// A-18 fail-closed guard for the Apple iCloud (CalDAV) adapter's unfinished
// Reminders (VTODO) surface. iCloud calendar sync is fully implemented, but
// task/reminder sync is a documented follow-up. The launch risk is a stub that
// SILENTLY SUCCEEDS — the engine would think a family's reminder synced when it
// never left the device. This asserts the task write path fails CLOSED (throws
// 501) and the read path advertises "no task sync" so the engine never drives it.

describe('A-18 Apple VTODO stubs fail closed (never silently succeed)', () => {
  it('defaultTaskListId() returns null → engine disables task sync for Apple', async () => {
    expect(await appleAdapter.defaultTaskListId('tok')).toBeNull();
  });

  it('listTasks() returns an empty set, not fabricated data', async () => {
    expect(await appleAdapter.listTasks('tok', 'list')).toEqual([]);
  });

  for (const [name, run] of [
    ['insertTask', () => appleAdapter.insertTask('tok', 'list', { title: 'x' })],
    ['patchTask', () => appleAdapter.patchTask('tok', 'list', 'task', { title: 'x' })],
    ['deleteTask', () => appleAdapter.deleteTask('tok', 'list', 'task')],
  ] as const) {
    it(`${name}() throws 501 rather than pretending the write happened`, async () => {
      await expect(run()).rejects.toBeInstanceOf(SyncApiError);
      await expect(run()).rejects.toMatchObject({ status: 501 });
    });
  }
});
