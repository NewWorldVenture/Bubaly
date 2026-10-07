import type { Db } from './db';
import { parseCards, type AssistantAction, type AssistantCard } from './assistant-core';

export type AssistantHistoryOwner = { userId: string; familyId: string };
export type SavedConversation = { id: string; title: string; updated_at: string };
export type HistoryCursor = { id: string; created_at: string };
export type AssistantMessage = {
  id: string; role: 'user' | 'assistant' | 'error'; content: string; created_at?: string;
  actions?: AssistantAction[]; cards?: AssistantCard[]; runIds?: string[]; responseError?: string;
};
export type HistoryPage = { messages: AssistantMessage[]; before: HistoryCursor | null };
export const CONVERSATION_PAGE_SIZE = 25;
export const MESSAGE_PAGE_SIZE = 100;

export function mergeAssistantHistory(earlier: AssistantMessage[], existing: AssistantMessage[]): AssistantMessage[] {
  return [...earlier.filter((message) => !existing.some((row) => row.id === message.id)), ...existing]
    .sort((a, b) => a.created_at && b.created_at ? a.created_at.localeCompare(b.created_at)
      || Number(a.role === 'assistant') - Number(b.role === 'assistant') : 0);
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function savedRunIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && uuid.test(id)))] : [];
}
export function savedActions(value: unknown): AssistantAction[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const action = record(entry);
    return typeof action.name === 'string' && typeof action.summary === 'string'
      ? [{ name: action.name, summary: action.summary, ok: action.ok !== false }] : [];
  }) : [];
}

/** Same authenticated client/RLS as the native modules; never load family-wide
 * assistant conversations. Personal conversations remain personal. */
export async function fetchAssistantConversations(db: Db, owner: AssistantHistoryOwner, signal: AbortSignal, offset = 0) {
  const { data, error } = await db.from('ai_conversations').select('id, title, updated_at')
    .eq('family_id', owner.familyId).eq('user_id', owner.userId)
    .order('updated_at', { ascending: false }).order('id', { ascending: false })
    .range(offset, offset + CONVERSATION_PAGE_SIZE).abortSignal(signal);
  if (error) throw error;
  const rows = data ?? [];
  return { conversations: rows.slice(0, CONVERSATION_PAGE_SIZE), hasMore: rows.length > CONVERSATION_PAGE_SIZE };
}

export async function fetchAssistantHistory(db: Db, owner: AssistantHistoryOwner, id: string, signal: AbortSignal, before?: HistoryCursor): Promise<HistoryPage> {
  // Verify ownership even on older-page reads; RLS remains the actual security boundary.
  const { data: conversation, error: ownerError } = await db.from('ai_conversations').select('id')
    .eq('id', id).eq('family_id', owner.familyId).eq('user_id', owner.userId).abortSignal(signal).maybeSingle();
  if (ownerError) throw ownerError;
  if (!conversation) throw new Error('Conversation unavailable');
  let query = db.from('ai_messages').select('id, role, content, tool_results, structured_content, created_at')
    .eq('conversation_id', id).eq('family_id', owner.familyId).in('role', ['user', 'assistant']);
  if (before) {
    // Both values came from saved rows, but reject malformed cursors rather than
    // interpolating unexpected PostgREST filter syntax.
    if (!uuid.test(before.id) || !/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(before.created_at)) throw new Error('Invalid history cursor');
    query = query.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE + 1).abortSignal(signal);
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, MESSAGE_PAGE_SIZE);
  const oldest = page.at(-1);
  // A turn's question/answer can share a transaction timestamp. Display the
  // question first regardless of their UUID ordering.
  const messages = [...page].sort((a, b) => a.created_at.localeCompare(b.created_at)
    || Number(a.role === 'assistant') - Number(b.role === 'assistant')).map((row): AssistantMessage => {
    const structured = record(row.structured_content);
    const cards = parseCards(structured.cards);
    const runIds = savedRunIds(structured.runIds);
    const actions = savedActions(row.tool_results);
    return { id: row.id, role: row.role === 'user' ? 'user' : 'assistant', content: row.content, created_at: row.created_at,
      ...(actions.length ? { actions } : {}), ...(cards.length ? { cards } : {}), ...(runIds.length ? { runIds } : {}),
      ...(typeof structured.responseError === 'string' ? { responseError: structured.responseError.slice(0, 1000) } : {}) };
  });
  return { messages, before: rows.length > MESSAGE_PAGE_SIZE && oldest ? { id: oldest.id, created_at: oldest.created_at } : null };
}
