// The household inbox's read boundary.
//
// Three tables, three independent reads, one ranked queue. This lives apart
// from the page so the fail-closed contract can be proved against a fake client
// (`tests/inbox-queue-read-boundary.test.ts`) rather than inferred from a React
// tree — the failure this guards against is a source that errors and renders as
// "nothing arrived", and that is exactly what a passing page render would hide.
//
// The contract:
//   * every failing read is logged with its own namespace, and marked
//     unavailable so the UI can say a part of the queue is missing;
//   * all three failing sets `allFailed`, and the page renders a retryable
//     error instead of a queue;
//   * a source that answers with no rows is empty, which is a different fact
//     from a source that did not answer, and the two never merge.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  countNeedsYou, unifyInbox,
  type CommunicationRow, type InboxMessageRow, type PaperworkRow, type UnifiedInboxItem,
} from './unify';

/** How far back each source is pulled. The queue is "what needs me", not an archive. */
export const PER_SOURCE_LIMIT = 60;

export type InboxQueueSources = { messages: boolean; paperwork: boolean; communications: boolean };

export type InboxQueueRead = {
  items: UnifiedInboxItem[];
  needsYou: number;
  /** Per source: true when that read errored. */
  unavailable: InboxQueueSources;
  /** True when nothing could be read at all — the page must not render a queue. */
  allFailed: boolean;
};

export async function loadInboxQueue(
  db: SupabaseClient<Database>,
  familyId: string,
  opts: { now?: Date } = {},
): Promise<InboxQueueRead> {
  const [messagesResult, paperworkResult, commsResult] = await Promise.all([
    db
      .from('family_inbox_messages')
      .select('id, channel, direction, from_addr, subject, body, ai_summary, ai_intent, ai_handled, status, occurred_at')
      .eq('family_id', familyId)
      .neq('status', 'archived')
      .order('occurred_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    db
      .from('paperwork_items')
      .select('id, kind, title, summary, sender, due_on, urgency, status, created_at')
      .eq('family_id', familyId)
      .in('status', ['needs_action', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    db
      .from('family_communications')
      .select('id, channel, subject, body, summary, category, status, priority, received_at')
      .eq('family_id', familyId)
      .neq('status', 'archived')
      .order('received_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
  ]);

  if (messagesResult.error) console.error('[dashboard/inbox] contact-center messages read failed', messagesResult.error);
  if (paperworkResult.error) console.error('[dashboard/inbox] paperwork read failed', paperworkResult.error);
  if (commsResult.error) console.error('[dashboard/inbox] communications log read failed', commsResult.error);

  const unavailable: InboxQueueSources = {
    messages: Boolean(messagesResult.error),
    paperwork: Boolean(paperworkResult.error),
    communications: Boolean(commsResult.error),
  };
  const allFailed = unavailable.messages && unavailable.paperwork && unavailable.communications;

  // A failed read contributes NOTHING rather than an empty array pretending to
  // be an answer; `unavailable` is what tells the UI the difference.
  const items = allFailed ? [] : unifyInbox({
    messages: messagesResult.error ? [] : ((messagesResult.data ?? []) as InboxMessageRow[]),
    paperwork: paperworkResult.error ? [] : ((paperworkResult.data ?? []) as PaperworkRow[]),
    communications: commsResult.error ? [] : ((commsResult.data ?? []) as CommunicationRow[]),
    now: opts.now,
  });

  return { items, needsYou: countNeedsYou(items), unavailable, allFailed };
}
