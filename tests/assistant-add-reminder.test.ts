import { describe, it, expect } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

type Captured = { table: string; payload: Record<string, unknown> }[];
type DbArg = Parameters<typeof buildAssistantTools>[0];

// Minimal fake Supabase that records insert() calls and reports success.
function fakeDb(captured: Captured): DbArg {
  return {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          captured.push({ table, payload });
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as DbArg;
}

const ctx: AssistantCtx = {
  familyId: 'fam-1',
  userId: 'user-1',
  // The acting person's roster id, which is a different key from `userId`.
  memberId: 'mem-self',
  members: [{ id: 'mem-emma', display_name: 'Emma' }],
  tz: 'America/New_York',
};

function addReminderTool(captured: { table: string; payload: Record<string, unknown> }[]) {
  const tools = buildAssistantTools(fakeDb(captured), ctx);
  const tool = tools.find((t) => t.name === 'add_reminder');
  if (!tool) throw new Error('add_reminder tool missing');
  return tool;
}

describe('assistant add_reminder tool', () => {
  it('writes to family_reminders (not the legacy reminders table) with sane defaults', async () => {
    const captured: { table: string; payload: Record<string, unknown> }[] = [];
    const res = await addReminderTool(captured).execute({ title: 'Pick up prescription', remind_at: '2026-07-01T17:00:00.000Z' });

    expect(res).toMatchObject({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].table).toBe('family_reminders');
    expect(captured[0].payload).toMatchObject({
      family_id: 'fam-1', created_by: 'user-1', title: 'Pick up prescription',
      remind_at: '2026-07-01T17:00:00.000Z', kind: 'time', priority: 'medium',
      recurrence: 'none', member_id: null, ai_suggested: true,
    });
  });

  it('honors priority, recurrence, and an assignee', async () => {
    const captured: { table: string; payload: Record<string, unknown> }[] = [];
    const res = await addReminderTool(captured).execute({
      title: 'Give Emma her vitamins', remind_at: '2026-07-01T08:00:00.000Z',
      priority: 'high', recurrence: 'daily', assignee: 'emma',
    }) as { ok: boolean; summary: string };

    expect(res.ok).toBe(true);
    expect(res.summary).toContain('Emma');
    expect(res.summary).toContain('repeats daily');
    expect(captured[0].payload).toMatchObject({
      priority: 'high', recurrence: 'daily', kind: 'recurring', member_id: 'mem-emma', ai_suggested: true,
    });
  });

  it('rejects bad enum values back to defaults and requires title + remind_at', async () => {
    const captured: { table: string; payload: Record<string, unknown> }[] = [];
    const bad = await addReminderTool(captured).execute({ title: '', remind_at: '' });
    expect(bad).toMatchObject({ ok: false });
    expect(captured).toHaveLength(0);

    const coerced = await addReminderTool(captured).execute({ title: 'x', remind_at: '2026-07-01T08:00:00.000Z', priority: 'bogus', recurrence: 'nope' });
    expect(coerced).toMatchObject({ ok: true });
    expect(captured[0].payload).toMatchObject({ priority: 'medium', recurrence: 'none' });
  });
});
