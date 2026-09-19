// lib/voice/history.ts — writing the family's voice history, which must never
// be the reason a user is told nothing.
//
// Both writes in `voice-module.tsx` were bare `await sb.from('voice_commands')
// .insert(...)`. On the success path the error was discarded on purpose ("a
// logging failure must not lose the thing we just created") and not even
// logged. On the FAILURE path it was worse than discarded: the insert sat
// inside the `catch` block, before `toastError`, and supabase-js rejects when
// the underlying fetch fails. So when the network was down — the reason the
// command failed in the first place — the log write rejected, the rejection
// escaped the catch, and the toast that would have told the user their command
// failed was never reached. The spinner stopped and nothing was said.
//
// The report to the user must not sit downstream of a call that fails for the
// same reason the user is being told about. This helper makes that structural:
// it cannot reject, so it cannot swallow anything after it. Audit C1-S8-06.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Insertable } from '@/lib/database.types';

export type VoiceHistoryRow = Insertable<'voice_commands'>;

/**
 * Best-effort write of one voice-history row. Never rejects and never throws —
 * a caller may `await` it in a `catch` block without losing the error it was
 * already handling.
 *
 * Best-effort is not silent: a dropped row is reported to the server logs, so
 * a history that has stopped recording looks different from a family that has
 * stopped speaking.
 */
export async function recordVoiceCommand(
  sb: SupabaseClient<Database>,
  row: VoiceHistoryRow,
): Promise<void> {
  try {
    const { error } = await sb.from('voice_commands').insert(row);
    if (error) console.error('[voice] command history write failed', { status: row.status, error });
  } catch (err) {
    console.error('[voice] command history write threw', { status: row.status, err });
  }
}
