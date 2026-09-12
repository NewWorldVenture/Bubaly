import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resumeGuardianSms } from './sms-processing';

type Client = SupabaseClient<Database>;
const TOOL = 'guardian.sms_intake';
const CURSOR_KEY = 'guardian.sms_intake:recovery_cursor:v1';
const QUERY_MS = 5000;
const RUN_MS = 80_000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const positionSchema = z.object({ id: uuid, createdAt: z.string().datetime({ offset: true }) }).strict();
const legacyCursorSchema = z.object({ version: z.literal(1), revision: uuid, position: positionSchema.nullable() }).strict();
const cursorSchema = z.object({ version: z.literal(2), revision: uuid, position: positionSchema.nullable(), horizon: positionSchema.nullable() }).strict();
const storedCursorSchema = z.union([cursorSchema, legacyCursorSchema]);
type Position = z.infer<typeof positionSchema>;
type Cursor = z.infer<typeof cursorSchema>;
type StoredCursor = z.infer<typeof storedCursorSchema>;
export type GuardianSmsRecoveryCounts = { examined: number; completed: number; busy: number; unavailable: number };

function unavailable(): never { throw new Error('Guardian SMS recovery unavailable'); }

/** Settle even when a transport ignores cancellation; do not begin work after abort. */
async function bounded<T>(parent: AbortSignal, run: (signal: AbortSignal) => PromiseLike<T>, timeout = QUERY_MS): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  let rejectOnAbort: () => void = () => {};
  try {
    if (parent.aborted) abort();
    if (controller.signal.aborted) return unavailable();
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new Error('Guardian SMS recovery unavailable'));
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    const result = await Promise.race([
      Promise.resolve().then(() => { if (controller.signal.aborted) return unavailable(); return run(controller.signal); }),
      interrupted,
    ]);
    if (controller.signal.aborted) return unavailable();
    return result;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readCursor(client: Client, signal: AbortSignal): Promise<StoredCursor | null> {
  const result = await bounded(signal, current => client.from('app_settings').select('key,value', { count: 'exact' })
    .eq('key', CURSOR_KEY).limit(2).retry(false).abortSignal(current));
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  if (!result.data.length) return null;
  const row = result.data[0];
  if (row.key !== CURSOR_KEY) return unavailable();
  return storedCursorSchema.parse(row.value);
}

async function initializeCursor(client: Client, signal: AbortSignal): Promise<Cursor> {
  let cursor = await readCursor(client, signal);
  if (!cursor) {
    const initial: Cursor = { version: 2, revision: randomUUID(), position: null, horizon: null };
    try {
      await bounded(signal, current => client.from('app_settings').insert({ key: CURSOR_KEY, value: initial })
        .select('key').retry(false).abortSignal(current));
    } catch { /* A competing initializer or lost response is resolved by readback. */ }
    cursor = await readCursor(client, signal);
  }
  if (!cursor) return unavailable();
  // The earlier cursor had no finite sweep boundary. Restart it through the
  // same revision fence so an older busy row receives another opportunity.
  if (cursor.version === 1) return await advanceCursor(client, cursor, null, null, signal) ?? unavailable();
  return cursor;
}

/** Reserve traversal before attempting a message, so a terminated worker cannot starve later rows. */
async function advanceCursor(client: Client, prior: StoredCursor, position: Position | null, horizon: Position | null, signal: AbortSignal): Promise<Cursor | null> {
  const next: Cursor = { version: 2, revision: randomUUID(), position, horizon };
  try {
    await bounded(signal, current => client.from('app_settings').update({ value: next }).eq('key', CURSOR_KEY)
      .contains('value', { version: prior.version, revision: prior.revision }).select('key').retry(false).abortSignal(current));
  } catch { /* Only exact readback establishes that this worker advanced the cursor. */ }
  const saved = await readCursor(client, signal);
  if (!saved) return unavailable();
  if (saved.revision === prior.revision) return unavailable();
  if (saved.revision !== next.revision) return null;
  if (saved.version !== 2 || JSON.stringify(saved.position) !== JSON.stringify(position)
    || JSON.stringify(saved.horizon) !== JSON.stringify(horizon)) return unavailable();
  return saved;
}

async function readHorizon(client: Client, signal: AbortSignal): Promise<Position | null> {
  const result = await bounded(signal, current => client.from('ai_tool_calls').select('id,created_at').eq('tool_name', TOOL)
    .in('outputs->>phase', ['captured', 'decided'])
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).retry(false).abortSignal(current));
  if (result.error || !Array.isArray(result.data) || result.data.length > 1) return unavailable();
  if (!result.data.length) return null;
  return positionSchema.parse({ id: result.data[0].id, createdAt: result.data[0].created_at });
}

async function nextCandidate(client: Client, cursor: Cursor, signal: AbortSignal): Promise<Position | null> {
  if (!cursor.horizon) return unavailable();
  const horizon = cursor.horizon;
  const result = await bounded(signal, current => {
    let query = client.from('ai_tool_calls').select('id,created_at').eq('tool_name', TOOL)
      .in('outputs->>phase', ['captured', 'decided'])
      .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1);
    const upper = `created_at.lt.${horizon.createdAt},and(created_at.eq.${horizon.createdAt},id.lte.${horizon.id})`;
    if (cursor.position) {
      const { createdAt, id } = cursor.position;
      const lower = `created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${id})`;
      query = query.or(`and(or(${lower}),or(${upper}))`);
    } else query = query.or(upper);
    return query.retry(false).abortSignal(current);
  });
  if (result.error || !Array.isArray(result.data) || result.data.length > 1) return unavailable();
  if (!result.data.length) return null;
  return positionSchema.parse({ id: result.data[0].id, createdAt: result.data[0].created_at });
}

/** Recover only service-authored receipts, with bounded work and fair traversal across ticks. */
export async function drainGuardianSmsReceipts(client: Client, options: { limit?: number; signal?: AbortSignal } = {}): Promise<GuardianSmsRecoveryCounts> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) return unavailable();
  const limit = Math.min(20, options.limit ?? 8);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, RUN_MS);
  const counts: GuardianSmsRecoveryCounts = { examined: 0, completed: 0, busy: 0, unavailable: 0 };
  try {
    if (options.signal?.aborted) abort();
    let cursor = await initializeCursor(client, controller.signal);
    let wrapped = false;
    const visited = new Set<string>();
    while (counts.examined < limit) {
      if (!cursor.horizon) {
        const horizon = await readHorizon(client, controller.signal);
        if (!horizon) break;
        const started = await advanceCursor(client, cursor, null, horizon, controller.signal);
        if (!started) { counts.busy += 1; break; }
        cursor = started;
      }
      const candidate = await nextCandidate(client, cursor, controller.signal);
      if (!candidate) {
        if (wrapped) break;
        const reset = await advanceCursor(client, cursor, null, null, controller.signal);
        if (!reset) { counts.busy += 1; break; }
        cursor = reset;
        wrapped = true;
        continue;
      }
      if (visited.has(candidate.id)) break;
      visited.add(candidate.id);
      const reserved = await advanceCursor(client, cursor, candidate, cursor.horizon, controller.signal);
      if (!reserved) { counts.busy += 1; break; }
      cursor = reserved;
      counts.examined += 1;
      try {
        const outcome = await bounded(controller.signal, signal => resumeGuardianSms(client, candidate.id, { signal }), 30_000);
        if (!['completed', 'busy', 'unavailable'].includes(outcome)) return unavailable();
        counts[outcome] += 1;
      } catch {
        counts.unavailable += 1;
        if (controller.signal.aborted) break;
      }
    }
    return counts;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
