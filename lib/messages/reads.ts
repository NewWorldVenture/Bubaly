import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';

type Db = SupabaseClient<Database>;
type ReadError = { message: string; code?: string; details?: string; hint?: string };
type Page<T> = { data: T[] | null; count: number | null; error: ReadError | null };
type Result<T> = { data: T[] | null; error: ReadError | null };
export type MessageCursor = Pick<Tables<'family_messages'>, 'id' | 'created_at'>;
export type MessageWindow = { cursor?: MessageCursor; inclusive?: boolean; kind?: 'photos' | 'pinned'; take?: number };
type Overview = Database['public']['Functions']['family_conversation_overview']['Returns'][number];
const PAGE = 1000;
const MAX_CONVERSATIONS = 10_000;

/** Exact counts describe the requested window, not the size a server chose to return.
 * Counts/identity drift and empty intermediate pages refuse the entire read. These
 * separately counted pages are not a database transaction. */
async function complete<T>(query: () => { limit: (n: number) => PromiseLike<Page<T>>; range: (from: number, to: number) => PromiseLike<Page<T>> }, identity: (row: T) => string | null, label: string, take?: number): Promise<Result<T>> {
  const fail = (details: string): Result<T> => ({ data: null, error: { message: `The ${label} could not be loaded completely.`, details } });
  const rows: T[] = [], seen = new Set<string>();
  let total: number | null = null;
  try {
    for (;;) {
      const target: number = total === null ? take ?? PAGE : Math.min(total, take ?? total);
      const result: Page<T> = await (rows.length ? query().range(rows.length, Math.min(rows.length + PAGE, target) - 1) : query().limit(Math.min(PAGE, take ?? PAGE)));
      if (result.error) return { data: null, error: result.error };
      if (!Number.isSafeInteger(result.count) || result.count === null || result.count < 0) return fail('The exact count was unavailable.');
      if (total !== null && total !== result.count) return fail('The count changed during the read.');
      total = result.count;
      const wanted = Math.min(total, take ?? total);
      if (wanted > MAX_CONVERSATIONS) return fail('The collection exceeds the safe read bound.');
      if (!Array.isArray(result.data)) return fail('The page was unavailable.');
      for (const row of result.data) {
        const id = identity(row);
        if (!id || seen.has(id)) return fail('A row had an invalid or repeated identity or scope.');
        seen.add(id); rows.push(row);
      }
      if (rows.length > wanted) return fail('The response exceeded its count or requested window.');
      if (rows.length === wanted) return { data: rows, error: null };
      if (!result.data.length) return fail('The read stopped before the requested window was complete.');
    }
  } catch (cause) { return fail(cause instanceof Error ? cause.message : String(cause)); }
}
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function readConversationInbox(db: Db, familyId: string): Promise<Result<Tables<'family_conversations'>>> {
  if (!familyId) return Promise.resolve({ data: null, error: { message: 'A family is required to read conversations.' } });
  return complete(() => db.from('family_conversations').select('*', { count: 'exact' }).eq('family_id', familyId)
    .order('last_message_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false }),
  row => row?.family_id === familyId && validId(row.id) ? row.id : null, 'conversation list');
}

export function readMessageWindow(db: Db, familyId: string, conversationId: string, options: MessageWindow = {}): Promise<Result<Tables<'family_messages'>>> {
  const take = options.take ?? 51;
  if (!familyId || !conversationId || !Number.isSafeInteger(take) || take < 1 || take > 1000
    || options.cursor && (!validId(options.cursor.id) || !Number.isFinite(Date.parse(options.cursor.created_at)))) {
    return Promise.resolve({ data: null, error: { message: 'The message window was invalid.' } });
  }
  const query = () => {
    let builder = db.from('family_messages').select('*', { count: 'exact' }).eq('family_id', familyId).eq('conversation_id', conversationId);
    if (options.kind) builder = options.kind === 'pinned' ? builder.is('deleted_at', null).eq('is_pinned', true) : builder.is('deleted_at', null).eq('kind', 'image');
    if (options.cursor) builder = builder.or(`created_at.lt.${options.cursor.created_at},and(created_at.eq.${options.cursor.created_at},id.${options.inclusive ? 'lte' : 'lt'}.${options.cursor.id})`);
    return builder.order('created_at', { ascending: false }).order('id', { ascending: false });
  };
  return complete(query, row => row?.family_id === familyId && row.conversation_id === conversationId && validId(row.id)
    && Number.isFinite(Date.parse(row.created_at)) ? row.id : null, 'message history', take);
}

export function readConversationOverview(db: Db, familyId: string): Promise<Result<Overview>> {
  if (!familyId) return Promise.resolve({ data: null, error: { message: 'A family is required to read conversation summaries.' } });
  return complete(() => db.rpc('family_conversation_overview', { p_family_id: familyId }, { count: 'exact' }).order('conversation_id'),
    row => validId(row?.conversation_id) && (typeof row.unread_count === 'number' || typeof row.unread_count === 'string' && /^[0-9]+$/.test(row.unread_count)) && Number.isSafeInteger(Number(row.unread_count)) && Number(row.unread_count) >= 0
      && (row.last_message === null || row.last_message !== null && typeof row.last_message === 'object' && !Array.isArray(row.last_message)
        && row.last_message.family_id === familyId && row.last_message.conversation_id === row.conversation_id)
      ? row.conversation_id : null, 'conversation summaries');
}
