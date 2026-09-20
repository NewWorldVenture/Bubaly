import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { NotifyInput, NotifyResult } from '@/lib/services/notifications';
import { dayKeyInTz, hourInTz, scopeForSystem, scopeNow, zonedTimeMs } from '@/lib/services/scope';
import { ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { guardianSmsNotificationId } from './sms-receipt';
import { smsStep } from './sms-deadline';

type Client = SupabaseClient<Database>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable(): never { throw new Error('Guardian SMS notification unavailable'); }

export async function guardianSmsScope(client: Client, familyId: string, signal?: AbortSignal): Promise<ServiceScope> {
  const result = await smsStep(signal, current => client.from('families').select('id,timezone', { count: 'exact' })
    .eq('id', familyId).limit(2).retry(false).abortSignal(current));
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1 || result.count !== 1
    || result.data[0].id !== familyId || (result.data[0].timezone !== null && typeof result.data[0].timezone !== 'string')) return unavailable();
  return scopeForSystem(client, result.data[0]);
}

/** Guardian only: one family notification, with a durable ID and exact readback. */
export async function notifyGuardianSms(scope: ServiceScope, input: NotifyInput, options: {
  receiptId: string; signal?: AbortSignal; beforeWrite: () => Promise<void>;
}): Promise<ServiceResult<NotifyResult>> {
  const { signal } = options;
  if (input.recipients !== 'family' || input.type !== 'system' || input.relatedType !== 'guardian_communications'
    || !input.relatedId || !UUID.test(input.relatedId) || !input.title.trim()) return unavailable();
  const expected = { family_id: scope.familyId, user_id: null, type: 'system' as const, title: input.title.trim(),
    body: input.body?.trim() || null, related_type: 'guardian_communications', related_id: input.relatedId };
  const read = async (): Promise<string | null> => {
    const result = await smsStep(signal, current => scope.db.from('notifications')
      .select('id,family_id,user_id,type,title,body,related_type,related_id,send_at', { count: 'exact' })
      .eq('family_id', scope.familyId).eq('related_type', expected.related_type).eq('related_id', expected.related_id)
      .limit(2).retry(false).abortSignal(current));
    if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
    if (!result.data.length) return null;
    const row = result.data[0];
    if (!UUID.test(row.id) || !Object.entries(expected).every(([key, value]) => row[key as keyof typeof row] === value)
      || typeof row.send_at !== 'string' || !Number.isFinite(Date.parse(row.send_at))) return unavailable();
    return row.id;
  };
  const existing = await read();
  if (existing) return ok({ created: 0, duplicates: 1, ids: [], skippedMemberIds: [], deferred: 0 });

  // Same family-local quiet-hours semantics as notify(), with bounded required
  // reads instead of a delayed fallback that might wake the family at night.
  const settings = await smsStep(signal, current => scope.db.from('family_ai_settings')
    .select('family_id,quiet_hours_start,quiet_hours_end', { count: 'exact' }).eq('family_id', scope.familyId)
    .limit(2).retry(false).abortSignal(current));
  if (settings.error || !Array.isArray(settings.data) || settings.count !== settings.data.length || settings.data.length > 1) return unavailable();
  const quiet = settings.data[0];
  if (quiet && (quiet.family_id !== scope.familyId || [quiet.quiet_hours_start, quiet.quiet_hours_end].some(value =>
    value !== null && (!Number.isInteger(value) || value < 0 || value > 23)))) return unavailable();
  const now = scopeNow(scope), hour = hourInTz(now, scope.tz);
  const start = quiet?.quiet_hours_start, end = quiet?.quiet_hours_end;
  const deferred = typeof start === 'number' && typeof end === 'number' && start !== end && hour !== null
    && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
  let sendAt = now.toISOString();
  if (deferred && typeof end === 'number') {
    const todayEnd = zonedTimeMs(dayKeyInTz(now, scope.tz), end, 0, scope.tz);
    const next = Number.isFinite(todayEnd) && todayEnd > now.getTime() ? todayEnd
      : zonedTimeMs(dayKeyInTz(new Date(now.getTime() + 86_400_000), scope.tz), end, 0, scope.tz);
    if (!Number.isFinite(next)) return unavailable();
    sendAt = new Date(next).toISOString();
  }
  await smsStep(signal, () => options.beforeWrite());
  const id = guardianSmsNotificationId(options.receiptId);
  try {
    await smsStep(signal, current => scope.db.from('notifications').insert({ ...expected, id, send_at: sendAt })
      .select('id').retry(false).abortSignal(current));
  } catch { /* A stable ID and exact readback reconcile a lost/duplicate insert. */ }
  if (await read() !== id) return unavailable();
  return ok({ created: 1, duplicates: 0, ids: [id], skippedMemberIds: [], deferred: deferred ? 1 : 0 });
}
