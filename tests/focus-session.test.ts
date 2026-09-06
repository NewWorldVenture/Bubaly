import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  completeFocusTodo, createFocusTimer, focusTimerReducer, runFocusAction, submitFocusChore,
} from '@/lib/focus/session';
import { FocusModule } from '@/components/modules/focus-module';

const scope = vi.hoisted(() => ({
  familyId: 'family-1', userId: 'user-1', selfMember: { id: 'member-1' } as { id: string } | null,
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => scope }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

function database(result: { data: Record<string, unknown> | null; error: { message: string } | null }) {
  const query = {
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  const update = vi.fn().mockReturnValue(query);
  const from = vi.fn().mockReturnValue({ update });
  return { client: { from } as unknown as SupabaseClient<Database>, from, update, query };
}

describe('Focus persisted outcomes', () => {
  it('confirms a todo row and scopes the existing update to its family', async () => {
    const db = database({ data: { id: 'todo-1', is_done: true }, error: null });
    await completeFocusTodo(db.client, 'family-1', 'todo-1');
    expect(db.from).toHaveBeenCalledWith('todo_items');
    expect(db.update).toHaveBeenCalledWith({ is_done: true });
    expect(db.query.eq).toHaveBeenCalledWith('family_id', 'family-1');
    expect(db.query.eq).toHaveBeenCalledWith('id', 'todo-1');
    expect(db.query.select).toHaveBeenCalledWith('id, is_done');
  });

  it.each([
    { data: null, error: null },
    { data: { id: 'todo-1', is_done: false }, error: null },
    { data: { id: 'another-todo', is_done: true }, error: null },
    { data: null, error: { message: 'Permission denied' } },
  ])('keeps the selected item when todo persistence is not confirmed: %j', async (result) => {
    const db = database(result);
    let index = 0;
    const onSuccess = vi.fn(() => { index += 1; });
    await expect(runFocusAction({ kind: 'todo', complete: () => completeFocusTodo(db.client, 'family-1', 'todo-1') }, onSuccess)).rejects.toThrow();
    expect(index).toBe(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('waits for a save before advancing', async () => {
    let release!: () => void;
    const save = new Promise<void>((resolve) => { release = resolve; });
    const onSuccess = vi.fn();
    const action = runFocusAction({ kind: 'todo', complete: () => save }, onSuccess);
    expect(onSuccess).not.toHaveBeenCalled();
    release();
    await action;
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('completed');
  });

  it('submits only the current member chore without approving or awarding it', async () => {
    const db = database({ data: { id: 'chore-1', status: 'submitted' }, error: null });
    const onSuccess = vi.fn();
    await runFocusAction({ kind: 'chore', submit: () => submitFocusChore(db.client, 'family-1', 'member-1', 'chore-1') }, onSuccess);
    expect(db.from).toHaveBeenCalledWith('chore_assignments');
    expect(db.update).toHaveBeenCalledWith({ status: 'submitted', submitted_at: expect.any(String) });
    expect(db.query.eq).toHaveBeenCalledWith('family_id', 'family-1');
    expect(db.query.eq).toHaveBeenCalledWith('member_id', 'member-1');
    expect(db.query.eq).toHaveBeenCalledWith('id', 'chore-1');
    expect(db.query.in).toHaveBeenCalledWith('status', ['todo', 'in_progress']);
    expect(db.query.select).toHaveBeenCalledWith('id, status');
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('submitted');
  });

  it.each([
    { data: null, error: null },
    { data: { id: 'chore-1', status: 'in_progress' }, error: null },
    { data: { id: 'other-chore', status: 'submitted' }, error: null },
    { data: null, error: { message: 'Permission denied' } },
  ])('does not advance after an unconfirmed chore submission: %j', async (result) => {
    const db = database(result);
    const onSuccess = vi.fn();
    await expect(runFocusAction({ kind: 'chore', submit: () => submitFocusChore(db.client, 'family-1', 'member-1', 'chore-1') }, onSuccess)).rejects.toThrow();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not write a chore without a member context', async () => {
    const db = database({ data: null, error: null });
    await expect(submitFocusChore(db.client, 'family-1', null, 'chore-1')).rejects.toThrow('member profile');
    expect(db.from).not.toHaveBeenCalled();
  });

  it('reviews events without treating them as completed or invoking mutations', async () => {
    const complete = vi.fn();
    const submit = vi.fn();
    const onSuccess = vi.fn();
    await runFocusAction({ kind: 'event', complete, submit }, onSuccess);
    expect(complete).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('reviewed');
  });

  it.each(['chore', 'todo'] as const)('does not advance a %s with no supported mutation', async (kind) => {
    const onSuccess = vi.fn();
    await expect(runFocusAction({ kind }, onSuccess)).rejects.toThrow('No supported save action');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('Focus timer', () => {
  it('starts idle and requires an explicit start', () => {
    const idle = createFocusTimer(5);
    expect(idle).toEqual({ status: 'idle', durationMs: 300_000, remainingMs: 300_000, deadlineMs: null });
    expect(focusTimerReducer(idle, { type: 'tick', now: 9_000_000 })).toBe(idle);
    expect(focusTimerReducer(idle, { type: 'start', now: 1_000 }).deadlineMs).toBe(301_000);
  });

  it('pauses and resumes the remaining time rather than restarting', () => {
    const running = focusTimerReducer(createFocusTimer(5), { type: 'start', now: 1_000 });
    const paused = focusTimerReducer(running, { type: 'pause', now: 61_000 });
    expect(paused.status).toBe('paused');
    expect(paused.remainingMs).toBe(240_000);
    expect(paused.deadlineMs).toBeNull();
    expect(focusTimerReducer(paused, { type: 'tick', now: 900_000 })).toBe(paused);
    const resumed = focusTimerReducer(paused, { type: 'resume', now: 900_000 });
    expect(resumed.deadlineMs).toBe(1_140_000);
    expect(focusTimerReducer(resumed, { type: 'tick', now: 930_000 }).remainingMs).toBe(210_000);
  });

  it('uses a deadline so delayed background ticks still expire correctly', () => {
    const running = focusTimerReducer(createFocusTimer(1), { type: 'start', now: 1_000 });
    const expired = focusTimerReducer(running, { type: 'tick', now: 600_000 });
    expect(expired).toEqual({ status: 'expired', durationMs: 60_000, remainingMs: 0, deadlineMs: null });
    expect(focusTimerReducer(expired, { type: 'resume', now: 700_000 })).toBe(expired);
    expect(focusTimerReducer(expired, { type: 'tick', now: 800_000 })).toBe(expired);
  });

  it('treats pausing after the deadline as expiry', () => {
    const running = focusTimerReducer(createFocusTimer(1), { type: 'start', now: 0 });
    expect(focusTimerReducer(running, { type: 'pause', now: 60_001 }).status).toBe('expired');
  });

  it.each(['running', 'paused', 'expired'] as const)('cancels a %s session back to idle', (status) => {
    const session = { ...createFocusTimer(15), status, remainingMs: 1_000, deadlineMs: status === 'running' ? 2_000 : null };
    expect(focusTimerReducer(session, { type: 'cancel' })).toEqual(createFocusTimer(15));
  });

  it('changes duration only outside an active or paused session', () => {
    const idle = focusTimerReducer(createFocusTimer(), { type: 'duration', minutes: 15 });
    expect(idle).toEqual(createFocusTimer(15));
    const running = focusTimerReducer(idle, { type: 'start', now: 0 });
    expect(focusTimerReducer(running, { type: 'duration', minutes: 45 })).toBe(running);
    const paused = focusTimerReducer(running, { type: 'pause', now: 1_000 });
    expect(focusTimerReducer(paused, { type: 'duration', minutes: 45 })).toBe(paused);
  });

  it('does not restart an active session and requires an explicit restart after expiry', () => {
    const running = focusTimerReducer(createFocusTimer(1), { type: 'start', now: 0 });
    expect(focusTimerReducer(running, { type: 'start', now: 10_000 })).toBe(running);
    const expired = focusTimerReducer(running, { type: 'tick', now: 60_000 });
    expect(focusTimerReducer(expired, { type: 'start', now: 70_000 }).deadlineMs).toBe(130_000);
  });

  it.each([0, -1, 121, 1.5, Number.NaN])('rejects invalid duration %s', (minutes) => {
    expect(() => createFocusTimer(minutes)).toThrow('1 to 120');
  });

  it('ignores an invalid clock input', () => {
    const idle = createFocusTimer();
    expect(focusTimerReducer(idle, { type: 'start', now: Number.NaN })).toBe(idle);
  });
});

describe('Focus context and UI wiring', () => {
  beforeEach(() => {
    scope.familyId = 'family-1';
    scope.userId = 'user-1';
    scope.selfMember = { id: 'member-1' };
  });

  it.each(['family', 'user', 'member', 'missing member'])('resets queue and timer identity on %s changes', (field) => {
    const key = FocusModule().key;
    if (field === 'family') scope.familyId = 'family-2';
    if (field === 'user') scope.userId = 'user-2';
    if (field === 'member') scope.selfMember = { id: 'member-2' };
    if (field === 'missing member') scope.selfMember = null;
    expect(FocusModule().key).not.toBe(key);
  });

  it('wires per-task reset, interval cleanup and save/skip guards without expiry mutations', () => {
    const source = readFileSync('components/modules/focus-module.tsx', 'utf8');
    expect(source).toContain('<FocusTimer key={current.id} />');
    expect(source).toContain('window.clearInterval(interval)');
    expect(source).toContain('if (!current || savingRef.current) return;');
    expect(source).toContain('if (!savingRef.current) setIndex((i) => i + 1);');
    expect(source).toContain('if (!active.current) return;');
    expect(source).toContain('disabled={saving}');
    expect(source).toContain('Skipped tasks remain open.');
    const timer = source.slice(source.indexOf('function FocusTimer()'));
    expect(timer).not.toContain('runFocusAction');
    expect(timer).not.toContain('setIndex');
    expect(timer).not.toContain('createClient');
    expect(timer).toContain('Time is up. Your task is not marked complete.');
  });
});
