'use server';

import { revalidatePath } from 'next/cache';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import type { Json } from '@/lib/database.types';

export type AdminSettings = {
  platformName: string;
  tagline: string;
  timezone: string;
  dateFormat: string;
  timeFormat: '12h' | '24h';
  weekStartsOn: 'Sunday' | 'Monday';
  maintenanceMode: boolean;
  passwordPolicy: 'Basic' | 'Medium' | 'Strong';
  sessionTimeoutMins: number;
  failedLoginLimit: number;
  twoFactor: boolean;
  ipWhitelisting: boolean;
  notifyNewUser: boolean;
  notifySubscription: boolean;
  notifyPayment: boolean;
  notifySecurity: boolean;
  notifySystem: boolean;
  storageLimitTB: number;
  dataRetentionYears: number;
  autoDeleteInactive: boolean;
  backupFrequency: 'Hourly' | 'Daily' | 'Weekly';
};

export const DEFAULT_SETTINGS: AdminSettings = {
  platformName: 'FamilyOS',
  tagline: 'A smarter way to manage your family',
  timezone: 'America/New_York',
  dateFormat: 'MMM DD, YYYY',
  timeFormat: '12h',
  weekStartsOn: 'Sunday',
  maintenanceMode: false,
  passwordPolicy: 'Strong',
  sessionTimeoutMins: 30,
  failedLoginLimit: 5,
  twoFactor: true,
  ipWhitelisting: false,
  notifyNewUser: true,
  notifySubscription: true,
  notifyPayment: true,
  notifySecurity: true,
  notifySystem: false,
  storageLimitTB: 10,
  dataRetentionYears: 2,
  autoDeleteInactive: false,
  backupFrequency: 'Daily',
};

const SETTINGS_KEY = 'platform';
type Result = { ok: true } | { ok: false; error: string };

/** Reads persisted admin settings, falling back to defaults for any missing keys. */
export async function getAdminSettings(): Promise<AdminSettings> {
  const supabase = createServiceClient();
  const { data } = await supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  const stored = (data?.value ?? {}) as Partial<AdminSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveAdminSettings(values: Partial<AdminSettings>): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = createServiceClient();
  const user = await getUser();
  const current = await getAdminSettings();
  const next = { ...current, ...values };
  const { error } = await supabase.from('app_settings').upsert(
    { key: SETTINGS_KEY, value: next as unknown as Json, updated_by: user?.id ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) return { ok: false, error: error.message };
  await logAudit(supabase, { familyId: null, actorId: user?.id ?? null, action: 'update', resource: 'app_settings', metadata: { via: 'site_admin' } });
  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function resetAdminSettings(): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = createServiceClient();
  const user = await getUser();
  const { error } = await supabase.from('app_settings').upsert(
    { key: SETTINGS_KEY, value: DEFAULT_SETTINGS as unknown as Json, updated_by: user?.id ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) return { ok: false, error: error.message };
  await logAudit(supabase, { familyId: null, actorId: user?.id ?? null, action: 'reset', resource: 'app_settings', metadata: { via: 'site_admin' } });
  revalidatePath('/admin/settings');
  return { ok: true };
}
