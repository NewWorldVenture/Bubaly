import 'server-only';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';
import { isAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';

export type AppLockRecord = { userId: string; config: AppLockConfig | null; revision: string };
export type AppLockRead = { ok: true; record: AppLockRecord | null } | { ok: false; error: unknown };
export type AppLockWrite =
  | { ok: true; record: AppLockRecord }
  | { ok: false; reason: 'conflict' | 'unavailable'; error?: unknown };

type Row = Database['public']['Tables']['app_lock_credentials']['Row'];
const COLUMNS = 'user_id, enabled, salt, hash, revision' as const;
const STORE_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validConfig(config: unknown): config is AppLockConfig {
  return isAppLockConfig(config) && /^[0-9a-f]{32}$/.test(config.salt) && /^[0-9a-f]{64}$/.test(config.hash);
}

function recordOf(row: Pick<Row, 'user_id' | 'enabled' | 'salt' | 'hash' | 'revision'>, userId: string): AppLockRecord | null {
  if (row.user_id !== userId || !UUID.test(row.revision)) return null;
  if (row.enabled === false && row.salt === null && row.hash === null) {
    return { userId, config: null, revision: row.revision };
  }
  const config = { enabled: row.enabled, salt: row.salt, hash: row.hash };
  return validConfig(config) ? { userId, config, revision: row.revision } : null;
}

/** Private credentials are never read through the browser's own-row client.
 * The caller must supply the identity established by getUser/requireUserContext.
 * Missing schema, credentials, malformed rows and failed reads all fail closed.
 */
export async function readAppLockRecord(userId: string): Promise<AppLockRead> {
  try {
    if (!UUID.test(userId)) return { ok: false, error: new Error('Invalid App Lock user') };
    const { data, error } = await createServiceClient().from('app_lock_credentials')
      .select(COLUMNS).eq('user_id', userId).abortSignal(AbortSignal.timeout(STORE_TIMEOUT_MS)).maybeSingle();
    if (error) return { ok: false, error };
    if (!data) return { ok: true, record: null };
    const record = recordOf(data, userId);
    return record ? { ok: true, record } : { ok: false, error: new Error('Invalid private App Lock record') };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A revision is the authorization fence. A stale settings/lock request must
 * not overwrite a newer PIN or lock transition. Null expectedRevision means
 * INSERT, never UPSERT. Clearing a PIN retains a tombstone and fresh revision.
 */
export async function replaceAppLockRecord(
  userId: string,
  expectedRevision: string | null,
  config: AppLockConfig | null,
): Promise<AppLockWrite> {
  try {
    if (!UUID.test(userId) || (expectedRevision !== null && !UUID.test(expectedRevision))
      || (config !== null && !validConfig(config))) {
      return { ok: false, reason: 'unavailable', error: new Error('Invalid private App Lock change') };
    }
    const db = createServiceClient();
    const revision = randomUUID();
    const next = {
      enabled: config?.enabled ?? false,
      salt: config?.salt ?? null, hash: config?.hash ?? null, revision,
      updated_at: new Date().toISOString(),
    };
    const query = expectedRevision === null
      ? db.from('app_lock_credentials').insert({ user_id: userId, ...next })
      : db.from('app_lock_credentials').update(next).eq('user_id', userId).eq('revision', expectedRevision);
    const { data, error } = await query.select(COLUMNS).abortSignal(AbortSignal.timeout(STORE_TIMEOUT_MS)).maybeSingle();
    if (error) {
      return error.code === '23505'
        ? { ok: false, reason: 'conflict' }
        : { ok: false, reason: 'unavailable', error };
    }
    if (!data) return { ok: false, reason: 'conflict' };
    const record = recordOf(data, userId);
    return record && record.revision === revision
      ? { ok: true, record }
      : { ok: false, reason: 'unavailable', error: new Error('App Lock write was not confirmed') };
  } catch (error) {
    return { ok: false, reason: 'unavailable', error };
  }
}
