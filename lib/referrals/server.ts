import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import {
  DEFAULT_REFERRAL_CONFIG, resolveReferralConfig, generateReferralCode, normalizeCode,
  type ReferralConfig,
} from '@/lib/referrals/core';

type DB = SupabaseClient<Database>;

const SETTINGS_KEY = 'referral_program';

/** Read the program config from marketing_settings (falls back to defaults). */
export async function getReferralConfig(supabase: DB): Promise<ReferralConfig> {
  const { data } = await supabase.from('marketing_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  return data ? resolveReferralConfig(data.value) : DEFAULT_REFERRAL_CONFIG;
}

/** Persist program config (admin only — caller must be gated). */
export async function setReferralConfig(supabase: DB, config: ReferralConfig, actorId: string | null): Promise<void> {
  await supabase.from('marketing_settings').upsert(
    { key: SETTINGS_KEY, value: config as unknown as Database['public']['Tables']['marketing_settings']['Insert']['value'], updated_by: actorId },
    { onConflict: 'key' },
  );
}

/**
 * Return a family's referral code, creating one on first use. Uses the
 * service-role client because referral_codes has no client write policy.
 * Retries on the (rare) unique-code collision.
 */
export async function getOrCreateReferralCode(
  familyId: string,
  opts: { familyName?: string | null; userId?: string | null } = {},
): Promise<string> {
  const service = createServiceClient();

  const { data: existing } = await service.from('referral_codes').select('code').eq('family_id', familyId).maybeSingle();
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateReferralCode(opts.familyName ?? undefined);
    const { data, error } = await service
      .from('referral_codes')
      .insert({ family_id: familyId, code, created_by: opts.userId ?? null })
      .select('code')
      .maybeSingle();
    if (data) return data.code;
    // 23505 = unique_violation: either the family row was just created (race) or
    // the code collided. Re-read the family's code; if present, use it.
    if (error?.code === '23505') {
      const { data: now } = await service.from('referral_codes').select('code').eq('family_id', familyId).maybeSingle();
      if (now) return now.code;
      continue; // code collision — try a fresh code
    }
    if (error) throw new Error(error.message);
  }
  throw new Error('Could not allocate a referral code');
}

export type ReferralListRow = Database['public']['Tables']['referrals']['Row'];

/** Referrals a family has made (as the referrer), newest first. */
export async function listReferralsForFamily(supabase: DB, familyId: string): Promise<ReferralListRow[]> {
  const { data } = await supabase
    .from('referrals')
    .select('*')
    .eq('referrer_family_id', familyId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/**
 * Attribute the current family to a referrer's code. Service-role write, but the
 * caller must have already verified the user belongs to `referredFamilyId`.
 */
export async function applyReferralCode(input: {
  rawCode: string;
  referredFamilyId: string;
  referredEmail?: string | null;
  source?: string;
}): Promise<ApplyResult> {
  const code = normalizeCode(input.rawCode);
  if (!code) return { ok: false, reason: 'Enter a referral code.' };

  const service = createServiceClient();
  const config = await getReferralConfig(service);
  if (!config.enabled) return { ok: false, reason: 'The referral program is currently paused.' };

  const { data: codeRow } = await service.from('referral_codes').select('family_id, code').eq('code', code).maybeSingle();
  if (!codeRow) return { ok: false, reason: 'That referral code was not found.' };
  if (codeRow.family_id === input.referredFamilyId) return { ok: false, reason: 'You cannot use your own referral code.' };

  // One referral per referred family (enforced by a unique constraint too).
  const { data: already } = await service.from('referrals').select('id').eq('referred_family_id', input.referredFamilyId).maybeSingle();
  if (already) return { ok: false, reason: 'Your family has already used a referral code.' };

  const { error } = await service.from('referrals').insert({
    code: codeRow.code,
    referrer_family_id: codeRow.family_id,
    referred_family_id: input.referredFamilyId,
    referred_email: input.referredEmail ?? null,
    status: 'signed_up',
    source: input.source ?? 'apply_code',
    referrer_reward_cents: config.referrerRewardCents,
    referred_reward_cents: config.referredRewardCents,
  });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/**
 * Mark a referred family's referral as converted when it first becomes paid.
 * Safe to call from the Stripe webhook on every subscription event — it only
 * acts on a still-'signed_up' referral and is otherwise a no-op.
 */
export async function markReferralConverted(service: DB, referredFamilyId: string): Promise<void> {
  const { data: ref } = await service
    .from('referrals')
    .select('id, status')
    .eq('referred_family_id', referredFamilyId)
    .maybeSingle();
  if (!ref || ref.status !== 'signed_up') return;
  await service
    .from('referrals')
    .update({ status: 'converted', converted_at: new Date().toISOString() })
    .eq('id', ref.id);
}
