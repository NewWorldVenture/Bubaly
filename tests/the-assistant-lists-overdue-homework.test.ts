import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getTool } from '@/lib/ai/tools/registry';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// "Does Ava have any homework?" reaches the assistant's `school.listHomeworkDue`
// tool with no window, and the tool's default window started NOW. Work that was
// due yesterday and is still open fell before it, so a child two assignments
// behind was told "No homework due in that window" — the most important
// homework there is, answered as none. The Homework board files the same rows
// under "Overdue".
//
// With no `from`, the tool now also returns open work that is already overdue,
// and marks each item `overdue`. Finished or handed-in work is still left out,
// and an explicit window is read as asked.

const FAMILY = 'family-one';
const NOW = new Date('2026-10-13T15:00:00Z');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-ava', memberId: 'member-ava', role: 'child', actorKind: 'member', tz: 'UTC', now: NOW,
});
const tool = getTool('school.listHomeworkDue')!;
type Item = { id: string; overdue: boolean };
const run = async (input: Record<string, unknown> = {}) => {
  const res = await tool.execute(scope(), input as never);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return (res as { ok: true; data: { homework: Item[] } }).data;
};

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('homework_assignments', [
    { id: 'hw-overdue', family_id: FAMILY, member_id: 'member-ava', title: 'Fractions worksheet', status: 'assigned', due_at: '2026-10-12T15:00:00Z' },
    { id: 'hw-started-overdue', family_id: FAMILY, member_id: 'member-ava', title: 'Volcano poster', status: 'in_progress', due_at: '2026-10-10T15:00:00Z' },
    { id: 'hw-handed-in', family_id: FAMILY, member_id: 'member-ava', title: 'Book report', status: 'submitted', due_at: '2026-10-11T15:00:00Z' },
    { id: 'hw-done', family_id: FAMILY, member_id: 'member-ava', title: 'Spelling list', status: 'done', due_at: '2026-10-11T15:00:00Z' },
    { id: 'hw-tomorrow', family_id: FAMILY, member_id: 'member-ava', title: 'Reading log', status: 'assigned', due_at: '2026-10-14T15:00:00Z' },
    { id: 'hw-other-family', family_id: 'family-two', member_id: 'member-zed', title: 'Not ours', status: 'assigned', due_at: '2026-10-12T15:00:00Z' },
  ]);
});

describe('the assistant lists overdue homework', () => {
  it('with no window, open work already overdue comes first and is marked overdue', async () => {
    const { homework } = await run();
    expect(homework.map((h) => [h.id, h.overdue])).toEqual([
      ['hw-started-overdue', true],
      ['hw-overdue', true],
      ['hw-tomorrow', false],
    ]);
  });

  it('its summary does not say "No homework due" while work is overdue', async () => {
    db.replace('homework_assignments', db.table('homework_assignments').filter((h) => h.id !== 'hw-tomorrow'));
    const data = await run();
    const summary = tool.summarize!({} as never, data as never);
    expect(summary).not.toMatch(/^No homework/);
    expect(summary).toContain('2 overdue');
  });

  it('an explicit window is read as asked', async () => {
    const { homework } = await run({ from: '2026-10-13T00:00:00Z', to: '2026-10-20T00:00:00Z' });
    expect(homework.map((h) => h.id)).toEqual(['hw-tomorrow']);
  });

  it('asking for finished work too does not bring back finished work from before the window', async () => {
    const { homework } = await run({ include_done: true });
    expect(homework.map((h) => h.id)).toEqual(['hw-started-overdue', 'hw-overdue', 'hw-tomorrow']);
  });
});
