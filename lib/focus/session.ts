import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type Client = SupabaseClient<Database>;

// Reuse the existing todo completion and chore-assignee submission paths.
// Returned rows are required: an error-free, zero-row update is not completion.
export async function completeFocusTodo(client: Client, familyId: string, id: string): Promise<void> {
  const { data, error } = await client.from('todo_items').update({ is_done: true })
    .eq('id', id).eq('family_id', familyId).select('id, is_done').maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.id !== id || data.is_done !== true) {
    throw new Error('To-do completion was not saved. Refresh and try again.');
  }
}

export async function submitFocusChore(client: Client, familyId: string, memberId: string | null, id: string): Promise<void> {
  if (!memberId) throw new Error('Your family member profile is unavailable.');
  const { data, error } = await client.from('chore_assignments')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', id).eq('family_id', familyId).eq('member_id', memberId)
    .in('status', ['todo', 'in_progress']).select('id, status').maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.id !== id || data.status !== 'submitted') {
    throw new Error('Chore submission was not saved. Refresh and try again.');
  }
}

export type FocusAction = {
  kind: 'event' | 'chore' | 'todo';
  complete?: () => Promise<void>;
  submit?: () => Promise<void>;
};
export type FocusOutcome = 'reviewed' | 'submitted' | 'completed';

/** The queue's success continuation must never run before persistence succeeds. */
export async function runFocusAction(item: FocusAction, onSuccess: (outcome: FocusOutcome) => void): Promise<void> {
  if (item.kind === 'event') {
    onSuccess('reviewed');
    return;
  }
  if (item.kind === 'chore' && item.submit) {
    await item.submit();
    onSuccess('submitted');
    return;
  }
  if (item.kind === 'todo' && item.complete) {
    await item.complete();
    onSuccess('completed');
    return;
  }
  throw new Error('No supported save action is available for this task.');
}

export type FocusTimerState = {
  status: 'idle' | 'running' | 'paused' | 'expired';
  durationMs: number;
  remainingMs: number;
  deadlineMs: number | null;
};
export type FocusTimerAction =
  | { type: 'start' | 'pause' | 'resume' | 'tick'; now: number }
  | { type: 'cancel' }
  | { type: 'duration'; minutes: number };

export function createFocusTimer(minutes = 25): FocusTimerState {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error('Choose a focus duration from 1 to 120 minutes.');
  }
  const durationMs = minutes * 60_000;
  return { status: 'idle', durationMs, remainingMs: durationMs, deadlineMs: null };
}

/** Pure, ephemeral timer state. Expiry has no task mutation or queue callback. */
export function focusTimerReducer(state: FocusTimerState, action: FocusTimerAction): FocusTimerState {
  if (action.type === 'cancel') return createFocusTimer(state.durationMs / 60_000);
  if (action.type === 'duration') {
    return state.status === 'running' || state.status === 'paused' ? state : createFocusTimer(action.minutes);
  }
  if (!Number.isFinite(action.now)) return state;
  if (action.type === 'start') {
    if (state.status !== 'idle' && state.status !== 'expired') return state;
    return { ...state, status: 'running', remainingMs: state.durationMs, deadlineMs: action.now + state.durationMs };
  }
  if (action.type === 'resume') {
    if (state.status !== 'paused') return state;
    return { ...state, status: 'running', deadlineMs: action.now + state.remainingMs };
  }
  if (state.status !== 'running' || state.deadlineMs === null) return state;
  const remainingMs = Math.max(0, state.deadlineMs - action.now);
  if (remainingMs === 0) return { ...state, status: 'expired', remainingMs: 0, deadlineMs: null };
  return action.type === 'pause'
    ? { ...state, status: 'paused', remainingMs, deadlineMs: null }
    : { ...state, remainingMs };
}
