import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

type Db = SupabaseClient<Database>;
type Prefs = Record<string, unknown>;

export type PrefsMerge =
  | { ok: true; prefs: Prefs }
  /** read_failed and write_failed carry the database error; contended means
   *  every attempt lost the race to another writer. Nothing was written. */
  | { ok: false; reason: 'read_failed' | 'write_failed' | 'contended'; error?: unknown };

const asPrefs = (value: unknown): Prefs =>
  value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Prefs) } : {};

/**
 * Change some keys of a member's `user_preferences.notification_prefs` without
 * writing back anybody else's (SRV-001 l7).
 *
 * That column is one JSON blob shared by App Lock, the capture shortcuts, the
 * Google Calendar token, the moment-prep state and more, and every writer did
 * read → merge → write of the WHOLE blob with nothing tying the write to the
 * read. So two writers overlapping put back whatever the first one read: a
 * member turning App Lock on in one tab while a shortcut save landed in
 * another was told "App Lock is on" and got the old config back, and the
 * Google sync — which holds its read across a Google HTTP call of up to 15 s —
 * erased any App Lock or shortcut change made in that window.
 *
 * `change` receives the prefs as they are NOW and returns the prefs to store.
 * The write is a compare-and-set on the row's `updated_at` (the trigger bumps
 * it on every update — the same guard lib/services/navigation uses), so a
 * write that lost the race changes nothing and `change` runs again on the
 * newer row. A read that fails is `read_failed`, never an empty blob — merging
 * into `{}` would erase every other key.
 */
export async function mergeNotificationPrefs(
  db: Db,
  userId: string,
  change: (prefs: Prefs) => Prefs,
  attempts = 4,
): Promise<PrefsMerge> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const read = await db.from('user_preferences')
      .select('notification_prefs, updated_at').eq('user_id', userId).maybeSingle();
    if (read.error) return { ok: false, reason: 'read_failed', error: read.error };
    const next = change(asPrefs(read.data?.notification_prefs));

    if (!read.data) {
      const inserted = await db.from('user_preferences')
        .insert({ user_id: userId, notification_prefs: next as Json }).select('user_id').maybeSingle();
      if (!inserted.error && inserted.data) return { ok: true, prefs: next };
      // Another writer created the row in between: merge onto theirs.
      if (inserted.error && (inserted.error as { code?: string }).code !== '23505') {
        return { ok: false, reason: 'write_failed', error: inserted.error };
      }
      continue;
    }

    const base = db.from('user_preferences').update({ notification_prefs: next as Json }).eq('user_id', userId);
    const guarded = read.data.updated_at ? base.eq('updated_at', read.data.updated_at) : base.is('updated_at', null);
    const saved = await guarded.select('user_id').maybeSingle();
    if (saved.error) return { ok: false, reason: 'write_failed', error: saved.error };
    if (saved.data) return { ok: true, prefs: next };
    // Zero rows: the row changed between the read and the write. Go again.
  }
  return { ok: false, reason: 'contended' };
}
