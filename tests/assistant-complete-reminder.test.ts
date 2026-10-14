import { describe, it, expect } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

type Captured = { op: string; payload?: Record<string, unknown> }[];
type DbArg = Parameters<typeof buildAssistantTools>[0];

// Minimal chainable Supabase stub: select-chains resolve to `selectRows` (a
// ranged one to those rows of it, as PostgREST answers); update resolves with
// its matched row, insert with { error: null }; both record their payloads.
function fakeDb(selectRows: Record<string, unknown>[], captured: Captured, updateRows: unknown[] = [{ id: 'row' }]): DbArg {
  const make = (table: string) => {
    let op: 'select' | 'update' | 'insert' = 'select';
    const tableRows = table === 'family_reminders' ? selectRows : [];
    let rows = tableRows;
    let columns: string | undefined;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select(value?: string) { columns = value; return b; }, eq: chain, ilike: chain, order: chain, limit: chain, not: chain,
      range(from: number, to: number) { rows = tableRows.slice(from, to + 1); return b; },
      update(p: Record<string, unknown>) { op = 'update'; captured.push({ op, payload: p }); return b; },
      insert(p: Record<string, unknown>) { op = 'insert'; captured.push({ op, payload: p }); return b; },
      then(resolve: (v: unknown) => void) {
        // A matched update answers `.select()` with its row (C1-S9-69); an
        // update with no `data` is a shape the client cannot give once asked.
        const projected = columns && columns !== '*'
          ? rows.map(row => Object.fromEntries(columns!.split(',').map(column => column.trim()).map(column => [column, row[column]])))
          : rows;
        resolve(op === 'select' ? { data: projected, error: null } : op === 'update' ? { data: updateRows, error: null } : { error: null });
      },
    });
    return b;
  };
  return { from: (table: string) => make(table) } as unknown as DbArg;
}

const ctx: AssistantCtx = { familyId: 'fam-1', userId: 'user-1', role: 'parent', memberId: 'mem-self', members: [], tz: 'America/New_York' };

function tool(name: string, selectRows: Record<string, unknown>[], captured: Captured, updateRows?: unknown[]) {
  const t = buildAssistantTools(fakeDb(selectRows, captured, updateRows), ctx).find((x) => x.name === name);
  if (!t) throw new Error(`${name} tool missing`);
  return t;
}

describe('assistant complete_reminder tool', () => {
  it('completes a one-off reminder (no recurrence spawn)', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r1', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Pay rent', recurrence: 'none', remind_at: '2026-07-01T09:00:00.000Z', kind: 'bill', priority: 'high', notes: null, member_id: null, location_name: null },
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
      { id: 'r2', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null },
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
    expect(res).toEqual({ ok: false, error: 'No active reminder matching “nope”.' });
    expect(captured).toHaveLength(0);
  });

  // C1-S9-69. The assistant speaks this answer, and the next occurrence of a
  // recurring reminder is inserted after the completion — so a completion that
  // matched nothing (a concurrent one already won) must fail AND schedule nothing.
  it('does not claim a completion that matched nothing, and schedules no second occurrence', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r3', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null },
    ], captured, []).execute({ title: 'plants' }) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, error: 'Could not complete the reminder.' });
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toMatchObject({ status: 'completed' });
    expect(captured.filter((c) => c.op === 'insert'), 'a second future reminder').toHaveLength(0);
  });

  it('does not claim a reschedule that matched nothing', async () => {
    const captured: Captured = [];
    const res = await tool('snooze_reminder', [{ id: 'r4', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Dentist' }], captured, [])
      .execute({ title: 'dentist', remind_at: '2026-08-01T09:00:00.000Z' }) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, error: 'Could not reschedule the reminder.' });
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toEqual({ remind_at: '2026-08-01T09:00:00.000Z' });
  });
});
