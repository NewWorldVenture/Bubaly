import type { Db } from './db';
import { OPEN_CHORE_STATUSES, completionPatch, explainRefusedCompletion, isManagerRole, isOpenChore, type CompletionRefusal } from './chores-core';
import { dayKey } from './format';
import { config } from './config';
import { READ_DEADLINE_MS, withDeadline } from './deadline';
import { MobileError } from './errors';
import { deviceLocale, mobileTranslate } from './mobile-i18n';
import { supabase as sessionClient } from './supabase';
import { buildCalendarRequest, parseCalendarReply, type CalendarOwner, type CalendarReply } from './calendar-core';

export type { EventRow } from './calendar-core';

const t = (key: string, params?: Record<string, string | number>) => mobileTranslate(deviceLocale(), key, params);

/**
 * A database or transport error, logged here and shown as fixed copy. The raw
 * message (a policy name, a trigger's wording, an auth server's phrase) is for
 * the log, not the screen — see errors.ts.
 */
function unavailable(key: string, cause: unknown, code?: string): MobileError {
  console.error(`[mobile-queries] ${key}`, cause);
  return new MobileError(t(key), code);
}

/** Read a JSON body, or null for a body that is not JSON (a captive portal's HTML, an empty 204). */
async function jsonBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export async function fetchUpcomingEvents(owner: CalendarOwner, days = 14, signal?: AbortSignal, now = new Date()): Promise<CalendarReply> {
  const { data, error } = await sessionClient.auth.getSession();
  // A session that cannot be read is not a changed account; it is shown as the
  // transport failure it is and the next load tries again.
  if (error) throw unavailable('mobileAssistant.network', error, 'network');
  if (!data.session || data.session.user.id !== owner.userId || signal?.aborted) throw new Error('Calendar account changed.');
  // The server derives the actual family timezone; request starts on that
  // family's date supplied by the caller rather than the travelling device.
  const fromDay = dayKey(now, owner.timezone ?? 'UTC');
  const { url, init } = buildCalendarRequest(config.apiUrl, data.session.access_token, owner, fromDay, days, signal);
  // The caller's signal (a newer load, leaving the screen) plus a deadline:
  // Android's fetch has no timeout of its own (deadline.ts).
  const deadline = withDeadline(signal, READ_DEADLINE_MS);
  let response: Response;
  let body: unknown;
  try {
    try {
      response = await fetch(url, { ...init, signal: deadline.signal });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw deadline.timedOut()
        ? unavailable('mobileAssistant.timedOut', cause, 'timeout')
        : unavailable('mobileAssistant.network', cause, 'network');
    }
    body = await jsonBody(response);
  } finally { deadline.clear(); }
  if (!response.ok) {
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    // The route refuses a closed or trial-ended family (lib/server/route-feature-gate.ts
    // `refuseIfLocked`) with a code the phone can name, as the web's paywall does.
    if (code === 'account_closed' || code === 'trial_expired') throw new MobileError(t(code === 'account_closed' ? 'mobileAssistant.accountClosed' : 'mobileAssistant.trialEnded'), code);
    // 409: the server resolved another active family than this phone did. A
    // retry re-asks the same question, so the copy names the remedy instead.
    if (response.status === 409) throw new MobileError(t('mobileAssistant.familyMismatch'), 'context_changed');
    throw new Error('Calendar unavailable. Please try again.');
  }
  if (body === null) throw new Error('Calendar unavailable. Please try again.');
  return parseCalendarReply(body, owner, { fromDay, days });
}

export type ChoreRow = {
  id: string; status: string; due_at: string | null; member_id: string;
  chores: { title: string; points: number; requires_approval: boolean } | null;
  family_members: { display_name: string } | null;
};

export const CHORE_PAGE_SIZE = 100;

/** The open assignments the phone shows, with the counts the page alone cannot give. */
export type ChorePage = {
  rows: ChoreRow[];
  /** Every todo / in_progress / submitted assignment, however many the page holds. */
  count: number;
  /** Every todo / in_progress assignment — the "N open" the stat and the subtitle report. */
  openCount: number;
};

export async function fetchOpenChores(supabase: Db, familyId: string, signal?: AbortSignal): Promise<ChorePage> {
  // Two reads: the capped page, and the exact count of open rows. The page's
  // own count is of everything it filters (submitted included); the stat and
  // the subtitle count only what is still to do, and a family with more than a
  // page of assignments must not read the page size as its total — the web's
  // board pages all assignments for the same reason (chores-module.tsx).
  let page = supabase
    .from('chore_assignments')
    .select('id, status, due_at, member_id, chores(title, points, requires_approval), family_members(display_name)', { count: 'exact' })
    .eq('family_id', familyId)
    .in('status', ['todo', 'in_progress', 'submitted'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(CHORE_PAGE_SIZE);
  let open = supabase
    .from('chore_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .in('status', [...OPEN_CHORE_STATUSES]);
  if (signal) { page = page.abortSignal(signal); open = open.abortSignal(signal); }
  const [pageResult, openResult] = await Promise.all([page, open]);
  if (pageResult.error) throw unavailable('mobileAssistant.choresUnavailable', pageResult.error);
  if (openResult.error) throw unavailable('mobileAssistant.choresUnavailable', openResult.error);
  const rows = (pageResult.data ?? []) as unknown as ChoreRow[];
  return {
    rows,
    count: pageResult.count ?? rows.length,
    openCount: openResult.count ?? rows.filter((row) => isOpenChore(row.status)).length,
  };
}

export type ChoreViewer = { familyId: string; memberId: string; role: string };
export type ChoreCompletion = { saved: true; status: 'done' | 'submitted' } | { saved: false; reason: CompletionRefusal };

/**
 * Mark an assignment done, the way `completeChoreAssignment` (lib/services/tasks)
 * does: settled to 'done' when the chore needs no approval, else 'submitted';
 * only while the row is still open, in this family, and — for anyone but a
 * parent or adult — still this member's. The write is confirmed with
 * `.select()`: a row that no longer matches (RLS filtered a sibling's chore, a
 * parent approved it meanwhile, it was removed on the web) is NOT a success,
 * and the read-back says why so the screen can say so too. The phone used to
 * write `status: 'submitted'` on the id alone with no `.select()`, so each of
 * those came back `{ error: null }` and was shown as "Waiting for approval".
 */
export async function completeChore(supabase: Db, assignment: Pick<ChoreRow, 'id' | 'chores'>, viewer: ChoreViewer, now = new Date()): Promise<ChoreCompletion> {
  const patch = completionPatch(assignment.chores, now);
  let write = supabase
    .from('chore_assignments')
    .update(patch)
    .eq('id', assignment.id)
    .eq('family_id', viewer.familyId)
    .in('status', [...OPEN_CHORE_STATUSES]);
  if (!isManagerRole(viewer.role)) write = write.eq('member_id', viewer.memberId);
  const { data, error } = await write.select('id, status').maybeSingle();
  if (error) throw unavailable('mobileAssistant.choreUpdateFailed', error);
  if (data) return { saved: true, status: patch.status };
  const { data: current, error: readError } = await supabase
    .from('chore_assignments')
    .select('member_id, status')
    .eq('id', assignment.id)
    .eq('family_id', viewer.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[mobile-queries] could not re-read a chore whose completion matched no row', readError);
    return { saved: false, reason: 'changed' };
  }
  return { saved: false, reason: explainRefusedCompletion(current, viewer) };
}

export type GroceryItemRow = { id: string; name: string; quantity: string | null; is_checked: boolean; created_at: string };

export const GROCERY_PAGE_SIZE = 200;

export type GroceryPage = {
  /** The family the list was read for, so a stale page is never written to with another family's id. */
  familyId: string;
  listId: string | null;
  listName: string | null;
  /** Live lists beyond the one shown; the web's shopping module switches between them, the phone shows the first. */
  otherLists: number;
  items: GroceryItemRow[];
  /** Every item on the list, however many the page holds. */
  count: number;
};

export async function fetchGroceryList(supabase: Db, familyId: string, signal?: AbortSignal): Promise<GroceryPage> {
  let lists = supabase
    // Both archive columns: only `archived_at` is written, so asking
    // `is_archived` alone shows the phone a list the web app has archived.
    .from('grocery_lists').select('id, name').eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    // The web's order (components/modules/shopping-module.tsx): the list it opens first is the one the phone shows.
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(50);
  if (signal) lists = lists.abortSignal(signal);
  const { data: listRows, error: listError } = await lists;
  if (listError) throw unavailable('mobileAssistant.groceryUnavailable', listError);
  const list = listRows?.[0];
  if (!list) return { familyId, listId: null, listName: null, otherLists: 0, items: [], count: 0 };
  let items = supabase
    .from('grocery_items').select('id, name, quantity, is_checked, created_at', { count: 'exact' })
    .eq('list_id', list.id).eq('family_id', familyId)
    .order('is_checked', { ascending: true }).order('created_at', { ascending: false }).order('id', { ascending: true }).limit(GROCERY_PAGE_SIZE);
  if (signal) items = items.abortSignal(signal);
  const { data, error, count } = await items;
  if (error) throw unavailable('mobileAssistant.groceryUnavailable', error);
  const rows = (data ?? []) as GroceryItemRow[];
  return { familyId, listId: list.id, listName: list.name, otherLists: (listRows?.length ?? 1) - 1, items: rows, count: count ?? rows.length };
}

/**
 * Check or uncheck an item. Resolves to the row as written, or NULL when no row
 * matched — removed on the web, cleared with the checked items, or no longer
 * this family's — so the screen can undo its optimistic flip instead of keeping
 * a tick on an item that is gone (the web's `checkItem` treats 0 rows as not found).
 */
export async function setGroceryChecked(supabase: Db, familyId: string, id: string, isChecked: boolean): Promise<{ id: string; is_checked: boolean } | null> {
  const { data, error } = await supabase.from('grocery_items').update({ is_checked: isChecked })
    .eq('id', id).eq('family_id', familyId).select('id, is_checked').maybeSingle();
  if (error) throw unavailable('mobileAssistant.groceryUpdateFailed', error);
  return data;
}

/**
 * The one normalised form a grocery item's name is compared under — mirrors
 * `normalizeName` in lib/groceries/normalize-name.ts, which Metro does not
 * bundle; tests/mobile-grocery-screen.test.ts asserts the two agree. Two copies
 * of a MATCHING rule only ever disagree about the items a family gets twice.
 */
export function normalizeGroceryName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
}

// Mirrors isMissingFunctionError in lib/supabase/errors.ts, which Metro does not bundle.
const missingFunction = (error: { code?: string; message?: string }) =>
  error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message ?? '');

/**
 * The family's default list, as ONE operation: 0443's `ensure_default_grocery_list`
 * holds a per-family advisory lock across the read and the insert, which is
 * what stops two first captures at once (this phone and the web, or two phones)
 * from giving the family two "Groceries" lists — of which the phone shows one.
 * Same call and same fallback as lib/services/groceries
 * (`ensureDefaultGroceryListId`): a database without 0443 answers "no such
 * function" and gets the read-then-insert that ran before; any other error is
 * an error, never "no list".
 */
async function ensureDefaultGroceryList(supabase: Db, familyId: string, userId: string): Promise<string> {
  const { data, error } = await supabase.rpc('ensure_default_grocery_list', { p_family_id: familyId, p_name: 'Groceries', p_created_by: userId });
  if (!error && typeof data === 'string') return data;
  if (error && !missingFunction(error)) throw unavailable('mobileAssistant.groceryAddFailed', error);
  const { data: existing, error: lookupError } = await supabase
    .from('grocery_lists').select('id').eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1).maybeSingle();
  if (lookupError) throw unavailable('mobileAssistant.groceryAddFailed', lookupError);
  if (existing) return existing.id;
  const { data: created, error: createError } = await supabase.from('grocery_lists')
    .insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
  if (createError || !created) throw unavailable('mobileAssistant.groceryAddFailed', createError ?? new Error('Grocery list was not created'));
  return created.id;
}

export type GroceryAdd = { listId: string; item: GroceryItemRow | null; duplicate: boolean };

/**
 * Add an item to the family's list. Skips a name already open on the list under
 * the same normalised form, as the web's `addItems` does: a retry after a
 * timeout (the phone keeps the draft) must not put "milk" on the list twice.
 * Resolves to the inserted row, so the screen can show it even when the
 * follow-up refresh fails.
 */
export async function addGroceryItem(supabase: Db, args: { familyId: string; listId: string | null; name: string; userId: string }): Promise<GroceryAdd> {
  const name = args.name.trim();
  const listId = args.listId ?? await ensureDefaultGroceryList(supabase, args.familyId, args.userId);
  const { data: open, error: openError } = await supabase
    .from('grocery_items').select('name').eq('family_id', args.familyId).eq('list_id', listId).eq('is_checked', false);
  if (openError) throw unavailable('mobileAssistant.groceryAddFailed', openError);
  const key = normalizeGroceryName(name);
  if ((open ?? []).some((row) => normalizeGroceryName(row.name) === key)) return { listId, item: null, duplicate: true };
  const { data, error } = await supabase.from('grocery_items')
    .insert({ family_id: args.familyId, list_id: listId, name, created_by: args.userId })
    .select('id, name, quantity, is_checked, created_at').single();
  if (error || !data) throw unavailable('mobileAssistant.groceryAddFailed', error ?? new Error('Grocery item was not created'));
  return { listId, item: data as GroceryItemRow, duplicate: false };
}
