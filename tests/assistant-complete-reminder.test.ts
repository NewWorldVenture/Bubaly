import { describe, it, expect } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

type Captured = { op: string; payload?: Record<string, unknown> }[];
type DbArg = Parameters<typeof buildAssistantTools>[0];

// Minimal chainable Supabase stub: select-chains resolve to `selectRows`;
// update/insert resolve to { error: null } and record their payloads.
function fakeDb(selectRows: Record<string, unknown>[], captured: Captured): DbArg {
  const make = () => {
    let op: 'select' | 'update' | 'insert' = 'select';
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: chain, ilike: chain, order: chain, limit: chain, not: chain,
      update(p: Record<string, unknown>) { op = 'update'; captured.push({ op, payload: p }); return b; },
      insert(p: Record<string, unknown>) { op = 'insert'; captured.push({ op, payload: p }); return b; },
      then(resolve: (v: unknown) => void) {
        resolve(op === 'select' ? { data: selectRows, error: null } : { error: null });
      },
    });
    return b;
  };
  return { from: () => make() } as unknown as DbArg;
}

const ctx: AssistantCtx = { familyId: 'fam-1', userId: 'user-1', memberId: 'mem-self', members: [], tz: 'America/New_York' };

function tool(name: string, selectRows: Record<string, unknown>[], captured: Captured) {
  const t = buildAssistantTools(fakeDb(selectRows, captured), ctx).find((x) => x.name === name);
  if (!t) throw new Error(`${name} tool missing`);
  return t;
}

describe('assistant complete_reminder tool', () => {
  it('completes a one-off reminder (no recurrence spawn)', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r1', title: 'Pay rent', recurrence: 'none', remind_at: '2026-07-01T09:00:00.000Z', kind: 'bill', priority: 'high', notes: null, member_id: null, location_name: null },
    ], captured).execute({ title: 'rent' }) as { ok: boolean; summary: string };

    expect(res.ok).toBe(true);
    expect(res.summary).toContain('Completed');
    expect(res.summary).not.toContain('next one');
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toMatchObject({ status: 'completed' });
    expect(captured.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('completes a recurring reminder and schedules the next occurrence', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r2', title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null },
    ], captured).execute({ title: 'plants' }) as { ok: boolean; summary: string };

    expect(res.ok).toBe(true);
    expect(res.summary).toContain('next one scheduled');
    const insert = captured.find((c) => c.op === 'insert');
    expect(insert).toBeTruthy();
    expect(insert!.payload).toMatchObject({ recurrence: 'monthly', remind_at: '2026-08-01T09:00:00.000Z', status: 'active' });
  });

  it('reports when no active reminder matches', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [], captured).execute({ title: 'nope' });
    expect(res).toMatchObject({ ok: false });
    expect(captured).toHaveLength(0);
  });
});
