/** Pure state rules shared by history, realtime and confirmed sends. */
export type ThreadRow = { id: string; conversation_id: string; created_at: string; deleted_at?: string | null };

export function mergeThreadRows<T extends ThreadRow>(current: readonly T[], incoming: readonly T[], conversationId: string): T[] {
  const rows = new Map(current.filter((row) => row.conversation_id === conversationId).map((row) => [row.id, row]));
  for (const row of incoming) if (row.conversation_id === conversationId) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** A reconnect snapshot is authoritative within the page it covers, including
 * rows deleted while offline. Preserve only history older than that window. */
export function reconcileLatestThreadRows<T extends ThreadRow>(current: readonly T[], incoming: readonly T[], conversationId: string): T[] {
  const page = mergeThreadRows([], incoming, conversationId);
  const oldest = page[0];
  if (!oldest) return [];
  const earlier = current.filter((row) => row.created_at < oldest.created_at || (row.created_at === oldest.created_at && row.id < oldest.id));
  return mergeThreadRows(earlier, page, conversationId);
}

/** Requests belong to a visit to a thread, not only its id (A → B → A). */
export function createThreadOwner() {
  let conversationId: string | null = null;
  let generation = 0;
  const requests = new Map<string, number>();
  return {
    select(id: string | null) { conversationId = id; generation++; requests.clear(); },
    capture() { return { conversationId, generation }; },
    current(ticket: { conversationId: string | null; generation: number }) {
      return ticket.conversationId === conversationId && ticket.generation === generation;
    },
    begin(kind: string) {
      const sequence = (requests.get(kind) ?? 0) + 1;
      requests.set(kind, sequence);
      return { conversationId, generation, kind, sequence };
    },
    accepts(ticket: { conversationId: string | null; generation: number; kind: string; sequence: number }) {
      return ticket.conversationId === conversationId && ticket.generation === generation && requests.get(ticket.kind) === ticket.sequence;
    },
  };
}

export type ThreadDraft<T> = { text: string; reply: T | null; edit: T | null };

/** Clear only the exact draft confirmed by the server; later typing survives. */
export function clearConfirmedDraft<T>(current: ThreadDraft<T>, submitted: ThreadDraft<T>): ThreadDraft<T> {
  return current.text === submitted.text && current.reply === submitted.reply && current.edit === submitted.edit
    ? { text: '', reply: null, edit: null }
    : current;
}

export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function messageReadByOthers(readBy: readonly string[] | null | undefined, senderId: string | null): boolean {
  return (readBy ?? []).some((id) => id !== senderId);
}
