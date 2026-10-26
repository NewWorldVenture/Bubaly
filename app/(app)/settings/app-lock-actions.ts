'use server';

import { cookies } from 'next/headers';
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { buildAppLockConfig, isValidPin, verifyPin } from '@/lib/security/app-lock';
import {
  APP_UNLOCK_COOKIE, appUnlockCookieOptions, canSignAppUnlock, isAppUnlocked,
  readAppLockSessionId, sealAppUnlock,
} from '@/lib/security/app-lock-server';
import { readAppLockRecord, replaceAppLockRecord } from '@/lib/security/app-lock-store';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

export type AppLockChange = { enabled: boolean; pin?: string };
type Result = { ok: true } | { ok: false; error: string };
export type AppLockSettingsResult = { ok: true; enabled: boolean; hasPin: boolean } | { ok: false; error: string };
export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_pin' | 'unavailable' }
  | { ok: false; reason: 'rate_limited'; retryAfter: number };

const UNLOCK_ATTEMPTS = 5;
const UNLOCK_WINDOW_MS = 5 * 60_000;

function isChange(value: unknown): value is AppLockChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) => key === 'enabled' || key === 'pin')
    && typeof input.enabled === 'boolean'
    && (input.pin === undefined || (typeof input.pin === 'string' && isValidPin(input.pin)));
}

/** Status only: the credential and its private revision never enter client props. */
export async function getAppLockSettings(): Promise<AppLockSettingsResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const loaded = await readAppLockRecord(ctx.user.id);
  if (!loaded.ok) return { ok: false, error: t('appLockActions.couldNotLoadAppLockSettings') };
  const record = loaded.record;
  if (record?.config?.enabled) {
    const supabase = await createServer();
    const sessionId = await readAppLockSessionId(supabase, ctx.user.id);
    if (!isAppUnlocked(ctx.user.id, record, sessionId, (await cookies()).get(APP_UNLOCK_COOKIE)?.value)) {
      return { ok: false, error: t('appLockActions.couldNotLoadAppLockSettings') };
    }
  }
  return { ok: true, enabled: record?.config?.enabled ?? false, hasPin: !!record?.config };
}

/**
 * Accept a PIN or an enable/disable command, never a browser-created verifier.
 * A revision compare-and-set binds authorization to the exact row written: a
 * concurrent PIN change or Lock now refuses this write instead of retrying
 * against a lock this browser has never unlocked.
 */
export async function saveAppLockConfig(change: AppLockChange | null): Promise<Result> {
  const t = await getTranslations();
  if (change !== null && !isChange(change)) return { ok: false, error: t('appLockActions.invalidLockConfiguration') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const sessionId = await readAppLockSessionId(supabase, ctx.user.id);
  if (!sessionId) return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
  const current = await readAppLockRecord(ctx.user.id);
  if (!current.ok) return { ok: false, error: t('appLockActions.couldNotLoadAppLockSettings') };
  const jar = await cookies();
  const record = current.record;
  if (record?.config?.enabled && !isAppUnlocked(ctx.user.id, record, sessionId, jar.get(APP_UNLOCK_COOKIE)?.value)) {
    return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
  }
  const config = change === null ? null : change.pin === undefined
    ? (record?.config ? { ...record.config, enabled: change.enabled } : null)
    : { ...(await buildAppLockConfig(change.pin)), enabled: change.enabled };
  if (change !== null && !config) return { ok: false, error: t('appLockActions.invalidLockConfiguration') };
  // Do not persist a new lock that this deployment cannot unlock.
  if (config?.enabled && !canSignAppUnlock()) return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
  const saved = await replaceAppLockRecord(ctx.user.id, record?.revision ?? null, config);
  if (!saved.ok) return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
  const unlock = config?.enabled ? sealAppUnlock(ctx.user.id, saved.record, sessionId) : null;
  if (unlock) jar.set(APP_UNLOCK_COOKIE, unlock, appUnlockCookieOptions());
  else jar.delete({ name: APP_UNLOCK_COOKIE, ...appUnlockCookieOptions() });
  return { ok: true };
}

/** Every PIN attempt spends a durable, per-user try before any verification. */
export async function unlockAppAction(pin: string): Promise<UnlockResult> {
  try {
    const supabase = await createServer();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    const user = auth?.user;
    if (authError || !user) return { ok: false, reason: 'unavailable' };
    const limited = await enforceRequestRateLimit(supabase, `app-lock:unlock:${user.id}`, {
      limit: UNLOCK_ATTEMPTS, windowMs: UNLOCK_WINDOW_MS,
    });
    if (!limited.ok) return { ok: false, reason: 'rate_limited', retryAfter: Math.max(1, limited.retryAfter) };
    const current = await readAppLockRecord(user.id);
    if (!current.ok) return { ok: false, reason: 'unavailable' };
    const record = current.record;
    if (!record?.config?.enabled) return { ok: true };
    if (typeof pin !== 'string' || !(await verifyPin(pin, record.config))) return { ok: false, reason: 'wrong_pin' };
    const sessionId = await readAppLockSessionId(supabase, user.id);
    if (!sessionId) return { ok: false, reason: 'unavailable' };
    const unlock = sealAppUnlock(user.id, record, sessionId);
    if (!unlock) return { ok: false, reason: 'unavailable' };
    // Rotation after this read still invalidates the cookie through its revision.
    const latest = await readAppLockRecord(user.id);
    if (!latest.ok || latest.record?.revision !== record.revision) return { ok: false, reason: 'unavailable' };
    (await cookies()).set(APP_UNLOCK_COOKIE, unlock, appUnlockCookieOptions());
    return { ok: true };
  } catch {
    // Never log the submitted PIN or a verifier on a failed transport.
    return { ok: false, reason: 'unavailable' };
  }
}

/** Revoke every prior unlock for this PIN, including an in-flight PIN response. */
export async function lockAppAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const jar = await cookies();
  jar.delete({ name: APP_UNLOCK_COOKIE, ...appUnlockCookieOptions() });
  const current = await readAppLockRecord(ctx.user.id);
  if (!current.ok) return { ok: false, error: t('appLockActions.couldNotLoadAppLockSettings') };
  if (!current.record?.config?.enabled) return { ok: true };
  const saved = await replaceAppLockRecord(ctx.user.id, current.record.revision, current.record.config);
  return saved.ok ? { ok: true } : { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
}
