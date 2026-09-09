import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  CAPTURE_CREATE_TOOLS, CAPTURE_TABLES, captureWindow, verifiedAutomaticCaptureShare,
  type AutomaticCaptureShare, type CaptureRecord, type CaptureToolProof,
} from './automatic-capture';

type DB = SupabaseClient<Database>;
export type AutomaticCaptureResult = { ok: true; data: AutomaticCaptureShare } | { ok: false };

/** Read until empty, including when the server applies a smaller page cap. */
async function readById<T extends { id: string }>(
  read: (cursor: string | null) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await read(cursor);
    if (page.error || !page.data) throw page.error ?? new Error('Capture records are unavailable');
    if (!page.data.length) return rows;
    for (const row of page.data) {
      if (!row.id || (cursor !== null && row.id <= cursor)) throw new Error('Capture read cursor did not advance');
      rows.push(row);
      cursor = row.id;
    }
  }
}

/** Uses the caller's RLS client. Proofs and document contents never leave this loader. */
export async function loadAutomaticCaptureShare(db: DB, familyId: string, now = new Date()): Promise<AutomaticCaptureResult> {
  try {
    if (!familyId) throw new Error('Capture household is unavailable');
    const window = captureWindow(now);
    const results = await Promise.all([
      readById((cursor) => {
        const query = db.from('calendar_events').select('id,family_id,created_at,feed_id,external_uid')
          .eq('family_id', familyId).gte('created_at', window.since).lte('created_at', window.until).order('id').limit(400);
        return cursor === null ? query : query.gt('id', cursor);
      }),
      readById((cursor) => {
        const query = db.from('todo_items').select('id,family_id,created_at')
          .eq('family_id', familyId).gte('created_at', window.since).lte('created_at', window.until).order('id').limit(400);
        return cursor === null ? query : query.gt('id', cursor);
      }),
      readById((cursor) => {
        const query = db.from('bills').select('id,family_id,created_at')
          .eq('family_id', familyId).gte('created_at', window.since).lte('created_at', window.until).order('id').limit(400);
        return cursor === null ? query : query.gt('id', cursor);
      }),
      readById((cursor) => {
        const query = db.from('family_reminders').select('id,family_id,created_at')
          .eq('family_id', familyId).gte('created_at', window.since).lte('created_at', window.until).order('id').limit(400);
        return cursor === null ? query : query.gt('id', cursor);
      }),
    ]);
    const records: CaptureRecord[] = [];
    for (let i = 0; i < results.length; i++) {
      for (const row of results[i]) records.push({
        id: row.id, familyId: row.family_id, createdAt: row.created_at, table: CAPTURE_TABLES[i],
        ...('feed_id' in row ? { feedId: row.feed_id as string | null, externalUid: row.external_uid as string | null } : {}),
      });
    }
    if (!records.length) return { ok: true, data: verifiedAutomaticCaptureShare({ familyId, records, tools: [], feeds: [], now }) };

    const feeds = await readById((cursor) => {
      const query = db.from('calendar_feeds').select('id,family_id').eq('family_id', familyId).order('id').limit(400);
      return cursor === null ? query : query.gt('id', cursor);
    });
    const ids = [...new Set(records.map((row) => row.id))];
    const tools: CaptureToolProof[] = [];
    // Resource IDs bound the proof lookup to these records, without losing a
    // creation call that started before the seven-day window. Small batches
    // keep the PostgREST URL below common proxy limits.
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const proof = await readById((cursor) => {
        const query = db.from('ai_tool_calls')
          .select('id,family_id,tool_name,state,actor_kind,resource_table,resource_id,outputs,finished_at')
          .eq('family_id', familyId).eq('state', 'succeeded').in('tool_name', Object.keys(CAPTURE_CREATE_TOOLS))
          .in('resource_id', batch).lte('finished_at', window.until).order('id').limit(400);
        return cursor === null ? query : query.gt('id', cursor);
      });
      for (const row of proof) {
        const outputs = row.outputs && typeof row.outputs === 'object' && !Array.isArray(row.outputs) ? row.outputs : {};
        tools.push({
          familyId: row.family_id, toolName: row.tool_name, state: row.state, actorKind: row.actor_kind,
          resourceTable: row.resource_table, resourceId: row.resource_id, finishedAt: row.finished_at,
          verified: outputs.verified === true,
        });
      }
    }
    return { ok: true, data: verifiedAutomaticCaptureShare({
      familyId, records, tools, feeds: feeds.map((feed) => ({ id: feed.id, familyId: feed.family_id })), now,
    }) };
  } catch (error) {
    console.error('[metric] automatic capture share read failed', error);
    return { ok: false };
  }
}
