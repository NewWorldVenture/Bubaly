// lib/sync/engine/exceptions.ts — a mirrored series remembers the occurrences
// its source gave up.
//
// A provider that lists a series as ONE master plus one event per changed or
// cancelled occurrence (Google, `singleEvents=false`) tells us two things about
// an exception: which master it belongs to (`recurring_event_id`) and the slot
// it left (`original_starts_at`). The master row must learn that slot, or the
// mirror — and the feed subscribers read from it — keeps expanding the series
// over a dentist appointment the family moved to Thursday, and over the one
// they cancelled.
//
// The exception can arrive WITH its master (a full pull) or ALONE (an
// incremental pull after the user cancelled one occurrence: Google emits the
// cancelled instance and does not touch the master). So the engine notes every
// exception it sees during the pull and folds them into the masters AFTER the
// loop, when the master's mapping exists whichever order the page came in.
//
// `sync_calendar_events.exception_dates` is the column (its migration is named
// in the PR that adds this file). A database that has not applied it yet is
// told apart from a failed write and handled the way lib/server/calendar-feeds
// handles the same column on `calendar_events`: the write is retried without
// the column, once per run a warning says the occurrences are not being
// remembered, and nothing else about the sync changes.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { NormalizedEvent } from '@/lib/sync/adapter';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { requireSyncWrite } from '@/lib/sync/persistence';

type Admin = SupabaseClient<Database>;
type Reply<T> = { data: T | null; error: unknown };

/** Per-run knowledge of whether this database has the column. */
export type ExceptionDatesSupport = { supported: boolean };
export const exceptionDatesSupport = (): ExceptionDatesSupport => ({ supported: true });

/** `true` for the one error that means "this database has no exception_dates column yet". */
export function isMissingExceptionDatesColumn(error: unknown): boolean {
  if (!isMissingRelationError(error)) return false;
  const message = String((error as { message?: unknown } | null)?.message ?? '').toLowerCase();
  return message.includes('exception_dates');
}

/** The exception-dates half of an insert or update patch, or nothing where the column is absent. */
export function exceptionDatesPatch(row: Pick<NormalizedEvent, 'exception_dates'>, support: ExceptionDatesSupport): { exception_dates?: string[] } {
  return support.supported ? { exception_dates: [...new Set(row.exception_dates ?? [])].sort() } : {};
}

/**
 * Run a mirror write that carries the column; if THIS error is the missing
 * column, say so once and run it again without. Any other error, and a
 * missing column after the retry, is the caller's to judge.
 */
export async function writeWithExceptionDates<T>(
  support: ExceptionDatesSupport,
  context: string,
  run: (support: ExceptionDatesSupport) => PromiseLike<Reply<T>>,
): Promise<Reply<T>> {
  const first = await run(support);
  if (!first.error || !support.supported || !isMissingExceptionDatesColumn(first.error)) return first;
  console.warn(`[sync] sync_calendar_events.exception_dates is not in this database yet (its migration has not been applied); ${context} without exception dates, so a moved or cancelled occurrence still shows at its original slot.`);
  support.supported = false;
  return run(support);
}

/** The exceptions a pull saw, by the master's external id. */
export type ExceptionLedger = Map<string, Set<string>>;
export const exceptionLedger = (): ExceptionLedger => new Map();

/** Remember an occurrence's original slot against its master. A row that is not an exception is ignored. */
export function noteException(ledger: ExceptionLedger, row: Pick<NormalizedEvent, 'recurring_event_id' | 'original_starts_at'>): boolean {
  if (!row.recurring_event_id || !row.original_starts_at) return false;
  const slots = ledger.get(row.recurring_event_id) ?? new Set<string>();
  slots.add(row.original_starts_at);
  ledger.set(row.recurring_event_id, slots);
  return true;
}

export type FoldResult = { folded: number; unchanged: number; orphaned: number };

/**
 * Give every master in the ledger the slots its exceptions left.
 *
 * Read-merge-write on the master's own row, found through its mapping. A
 * master this account has never mirrored (an exception whose series lies
 * outside the pulled window) is counted, not invented. A master whose row
 * already carries every slot is left alone, so a full resync writes nothing.
 */
export async function foldExceptionsIntoMasters(
  admin: Admin,
  args: { accountId: string; provider: Database['public']['Enums']['sync_provider']; ledger: ExceptionLedger; support: ExceptionDatesSupport },
): Promise<FoldResult> {
  const result: FoldResult = { folded: 0, unchanged: 0, orphaned: 0 };
  if (!args.support.supported || args.ledger.size === 0) return result;

  for (const [masterExternalId, slots] of args.ledger) {
    const { data: mapping, error: mappingError } = await admin
      .from('sync_external_mappings')
      .select('local_id')
      .eq('account_id', args.accountId).eq('provider', args.provider).eq('item_type', 'event').eq('external_id', masterExternalId)
      .maybeSingle();
    if (mappingError) throw new Error('Sync series mapping lookup failed');
    if (!mapping) { result.orphaned += 1; continue; }

    const { data: master, error: masterError } = await admin
      .from('sync_calendar_events')
      .select('id, exception_dates')
      .eq('id', mapping.local_id)
      .maybeSingle();
    if (masterError && isMissingExceptionDatesColumn(masterError)) {
      console.warn('[sync] sync_calendar_events.exception_dates is not in this database yet (its migration has not been applied); the occurrences a series gave up are not being remembered.');
      args.support.supported = false;
      return result;
    }
    if (masterError || !master) throw new Error('Sync series lookup failed');

    const known = new Set((master.exception_dates ?? []) as string[]);
    const merged = [...new Set([...known, ...slots])].sort();
    if (merged.length === known.size) { result.unchanged += 1; continue; }

    const { data: written, error: writeError } = await admin
      .from('sync_calendar_events')
      .update({ exception_dates: merged })
      .eq('id', master.id)
      .select('id')
      .maybeSingle();
    requireSyncWrite(written, writeError, 'series exception dates update');
    result.folded += 1;
  }
  return result;
}
