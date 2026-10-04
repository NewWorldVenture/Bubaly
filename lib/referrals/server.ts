import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';
import { wroteNoRows } from '@/lib/supabase/errors';
import {
  DEFAULT_REFERRAL_CONFIG, resolveReferralConfig, generateReferralCode, normalizeCode,
  REFERRAL_EMAIL_POLICY, REFERRAL_EMAIL_SOURCE, evaluateReferralEmailThrottle, referralEmailSendTimes, withReferralEmailSent,
  rewardRecordFrom, rewardSidesOwed, withRewardRecord, rewardIdempotencyKey,
  type ReferralConfig, type ReferralRewardSide,
} from '@/lib/referrals/core';

type DB = SupabaseClient<Database>;
type ReferralMetadata = Database['public']['Tables']['referrals']['Update']['metadata'];

const SETTINGS_KEY = 'referral_program';

/** Read the program config from marketing_settings (falls back to defaults). */
export async function getReferralConfigResult(supabase: DB): Promise<{ config: ReferralConfig; error: Error | null }> {
  const { data, error } = await supabase.from('marketing_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  return {
    config: data ? resolveReferralConfig(data.value) : DEFAULT_REFERRAL_CONFIG,
    error: error ? new Error('Referral program settings read failed') : null,
  };
}

export async function getReferralConfig(supabase: DB): Promise<ReferralConfig> {
  return (await getReferralConfigResult(supabase)).config;
}

/** Persist program config (admin only — caller must be gated). */
export async function setReferralConfig(supabase: DB, config: ReferralConfig, actorId: string | null): Promise<void> {
  const { data, error } = await supabase.from('marketing_settings').upsert(
    { key: SETTINGS_KEY, value: config as unknown as Database['public']['Tables']['marketing_settings']['Insert']['value'], updated_by: actorId },
    { onConflict: 'key' },
  ).select('key').maybeSingle();
  if (error || !data) throw error ?? new Error('Referral program settings were not saved');
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
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('referrer_family_id', familyId)
    .order('created_at', { ascending: false });
  // Fail closed: the referrals page is source-of-truth. A swallowed read error
  // would show "no referrals yet" when the list is merely unreadable.
  if (error) {
    console.error('[referrals/server] referrals read failed', { familyId, error });
    throw new Error('Could not load your referrals from Supabase. Refresh and try again.');
  }
  return data ?? [];
}

export type ApplyFailureCode = 'empty' | 'paused' | 'not_found' | 'own_code' | 'already_referred' | 'lookup_failed' | 'write_failed';
export type ApplyResult = { ok: true } | { ok: false; reason: string; code: ApplyFailureCode };

/**
 * Attribute the current family to a referrer's code. Service-role write, but the
 * caller must have already verified the user belongs to `referredFamilyId`.
 *
 * A family the referrer already emailed from the referral panel has a
 * 'pending' row carrying their address; that row is upgraded rather than
 * duplicated, so the referrer's list shows one family moving through the
 * funnel instead of an emailed ghost beside a signed-up twin.
 */
export async function applyReferralCode(input: {
  rawCode: string;
  referredFamilyId: string;
  referredEmail?: string | null;
  source?: string;
}): Promise<ApplyResult> {
  const code = normalizeCode(input.rawCode);
  if (!code) return { ok: false, reason: 'Enter a referral code.', code: 'empty' };

  const service = createServiceClient();
  const config = await getReferralConfig(service);
  if (!config.enabled) return { ok: false, reason: 'The referral program is currently paused.', code: 'paused' };

  const lookupFailed: ApplyResult = { ok: false, reason: 'We could not apply that referral code right now. Please try again.', code: 'lookup_failed' };

  const { data: codeRow, error: codeError } = await service.from('referral_codes').select('family_id, code').eq('code', code).maybeSingle();
  if (codeError) {
    console.error('[referrals/server] referral code read failed', { code, error: codeError });
    return lookupFailed;
  }
  if (!codeRow) return { ok: false, reason: 'That referral code was not found.', code: 'not_found' };
  if (codeRow.family_id === input.referredFamilyId) return { ok: false, reason: 'You cannot use your own referral code.', code: 'own_code' };

  // One referral per referred family (enforced by a unique constraint too).
  const { data: already, error: alreadyError } = await service.from('referrals').select('id').eq('referred_family_id', input.referredFamilyId).maybeSingle();
  if (alreadyError) {
    console.error('[referrals/server] existing referral read failed', { familyId: input.referredFamilyId, error: alreadyError });
    return lookupFailed;
  }
  if (already) return { ok: false, reason: 'Your family has already used a referral code.', code: 'already_referred' };

  const email = input.referredEmail?.trim().toLowerCase() || null;
  const source = input.source ?? 'apply_code';

  // An emailed invite to this address from the same referrer becomes the
  // signed-up row (keeps the referrer's list honest: one family, one row).
  if (email) {
    const { data: emailed, error: emailedError } = await service
      .from('referrals')
      .select('id')
      .eq('code', codeRow.code)
      .eq('status', 'pending')
      .is('referred_family_id', null)
      .eq('referred_email', email)
      .limit(1)
      .maybeSingle();
    if (emailedError) {
      console.error('[referrals/server] emailed referral read failed', { code, error: emailedError });
      return lookupFailed;
    }
    if (emailed) {
      const { data: upgraded, error: upgradeError } = await service
        .from('referrals')
        .update({ referred_family_id: input.referredFamilyId, status: 'signed_up', source })
        .eq('id', emailed.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      if (upgradeError || !upgraded) {
        console.error('[referrals/server] emailed referral upgrade failed', { id: emailed.id, error: upgradeError });
        return { ok: false, reason: 'We could not apply that referral code right now. Please try again.', code: 'write_failed' };
      }
      return { ok: true };
    }
  }

  const { error } = await service.from('referrals').insert({
    code: codeRow.code,
    referrer_family_id: codeRow.family_id,
    referred_family_id: input.referredFamilyId,
    referred_email: email,
    status: 'signed_up',
    source,
    referrer_reward_cents: config.referrerRewardCents,
    referred_reward_cents: config.referredRewardCents,
  });
  if (error) {
    // 23505 = the unique (referred_family_id) constraint won a race with a
    // concurrent apply — the family IS referred, just not by this call.
    if (error.code === '23505') return { ok: false, reason: 'Your family has already used a referral code.', code: 'already_referred' };
    console.error('[referrals/server] referral insert failed', { code, familyId: input.referredFamilyId, error });
    return { ok: false, reason: 'We could not apply that referral code right now. Please try again.', code: 'write_failed' };
  }
  return { ok: true };
}

/**
 * Mark a referred family's referral as converted when it first becomes paid.
 * Safe to call from the Stripe webhook on every subscription event — it only
 * acts on a still-'signed_up' referral and is otherwise a no-op.
 */
export async function markReferralConverted(service: DB, referredFamilyId: string): Promise<void> {
  const { data: ref, error: readError } = await service
    .from('referrals')
    .select('id, status')
    .eq('referred_family_id', referredFamilyId)
    .maybeSingle();
  if (readError) throw new Error('Referral lookup failed');
  if (!ref || ref.status !== 'signed_up') return;
  const { data: updated, error } = await service
    .from('referrals')
    .update({ status: 'converted', converted_at: new Date().toISOString() })
    .eq('id', ref.id).eq('status', 'signed_up').select('id').maybeSingle();
  if (error || !updated) throw new Error('Referral conversion persistence failed');
}

// ── Reward fulfilment ─────────────────────────────────────────────────────────

/**
 * The slice of the Stripe client the reward needs. Narrow so a test can hand
 * in a recorder; the real client (`getStripe()`) satisfies it structurally.
 */
export type StripeCustomerCredits = {
  customers: {
    retrieve(id: string): Promise<{ id: string; deleted?: boolean | void; currency?: string | null }>;
    createBalanceTransaction(
      id: string,
      params: { amount: number; currency: string; description?: string; metadata?: Record<string, string> },
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string }>;
  };
};

export type RewardOutcome =
  | { outcome: 'rewarded'; referralId: string }
  | { outcome: 'already_rewarded'; referralId: string }
  | { outcome: 'not_converted'; referralId: string; status: string }
  | { outcome: 'not_found'; referralId: string }
  | { outcome: 'read_failed'; referralId: string }
  | { outcome: 'missing_customer'; referralId: string; side: ReferralRewardSide }
  | { outcome: 'credit_failed'; referralId: string; side: ReferralRewardSide; error: string }
  | { outcome: 'persist_failed'; referralId: string; error: string };

export type RewardDeps = {
  stripe?: StripeCustomerCredits;
  /** The referred family's Stripe customer from the subscription event, used when billing_customers has no ref yet. */
  referredCustomerRef?: string | null;
  now?: Date;
};

async function customerRefForFamily(service: DB, familyId: string): Promise<{ ref: string | null; error: unknown }> {
  const { data, error } = await service.from('billing_customers').select('customer_ref').eq('family_id', familyId).maybeSingle();
  return { ref: data?.customer_ref ?? null, error };
}

/**
 * Credit both families' Stripe customer balances for a 'converted' referral and
 * flip it to 'rewarded' — only once Stripe has confirmed BOTH credits.
 *
 * Idempotent for webhook retries: a 'rewarded' row is a no-op; a side already
 * credited (its balance-transaction id is on the row's metadata) is skipped;
 * each Stripe call carries a per-side idempotency key. A family with no
 * Stripe customer yet leaves the row 'converted' for the next event to retry.
 * A negative customer balance is a credit that Stripe applies to the next
 * invoice automatically.
 */
export async function rewardReferral(service: DB, referralId: string, deps: RewardDeps = {}): Promise<RewardOutcome> {
  const now = deps.now ?? new Date();
  const { data: row, error: readError } = await service
    .from('referrals')
    .select('id, code, status, referrer_family_id, referred_family_id, referrer_reward_cents, referred_reward_cents, metadata')
    .eq('id', referralId)
    .maybeSingle();
  if (readError) {
    console.error('[referrals/reward] referral read failed', { referralId, error: readError });
    return { outcome: 'read_failed', referralId };
  }
  if (!row) return { outcome: 'not_found', referralId };
  if (row.status === 'rewarded') return { outcome: 'already_rewarded', referralId };
  if (row.status !== 'converted') return { outcome: 'not_converted', referralId, status: row.status };

  let metadata: unknown = row.metadata;
  const persistMetadata = async (next: Record<string, unknown>): Promise<string | null> => {
    const { data, error } = await service
      .from('referrals')
      .update({ metadata: next as ReferralMetadata })
      .eq('id', referralId)
      .select('id')
      .maybeSingle();
    if (error || !data) return error?.message ?? 'referral row vanished';
    metadata = next;
    return null;
  };

  for (const side of rewardSidesOwed(rewardRecordFrom(metadata))) {
    const amount = side === 'referrer' ? row.referrer_reward_cents : row.referred_reward_cents;
    const familyId = side === 'referrer' ? row.referrer_family_id : row.referred_family_id;

    if (!Number.isFinite(amount) || amount <= 0) {
      const err = await persistMetadata(withRewardRecord(metadata, { [`${side}_skipped`]: 'zero_amount' }));
      if (err) return { outcome: 'persist_failed', referralId, error: err };
      continue;
    }
    if (!familyId) {
      console.warn('[referrals/reward] referral has no family on this side; leaving converted', { referralId, side });
      return { outcome: 'missing_customer', referralId, side };
    }

    const { ref: storedRef, error: customerError } = await customerRefForFamily(service, familyId);
    if (customerError) {
      console.error('[referrals/reward] billing customer read failed', { referralId, side, familyId, error: customerError });
      return { outcome: 'read_failed', referralId };
    }
    const customerRef = storedRef ?? (side === 'referred' ? deps.referredCustomerRef ?? null : null);
    if (!customerRef) {
      console.warn('[referrals/reward] family has no Stripe customer yet; leaving converted', { referralId, side, familyId });
      return { outcome: 'missing_customer', referralId, side };
    }

    let txnId: string;
    try {
      const stripe = deps.stripe ?? getStripe();
      const customer = await stripe.customers.retrieve(customerRef);
      if (customer.deleted) {
        console.warn('[referrals/reward] Stripe customer is deleted; leaving converted', { referralId, side, familyId });
        return { outcome: 'missing_customer', referralId, side };
      }
      const txn = await stripe.customers.createBalanceTransaction(
        customerRef,
        {
          amount: -Math.round(amount),
          currency: customer.currency ?? 'usd',
          description: `Bubaly referral credit (${row.code})`,
          metadata: { referral_id: referralId, family_id: familyId, side },
        },
        { idempotencyKey: rewardIdempotencyKey(referralId, side) },
      );
      txnId = txn.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[referrals/reward] Stripe credit failed', { referralId, side, familyId, error: message });
      return { outcome: 'credit_failed', referralId, side, error: message };
    }

    const err = await persistMetadata(withRewardRecord(metadata, { [`${side}_txn`]: txnId }));
    if (err) {
      // The credit exists in Stripe; the idempotency key makes the retry return
      // the same transaction rather than a second credit.
      console.error('[referrals/reward] credit persisted in Stripe but not on the referral row', { referralId, side, txnId, error: err });
      return { outcome: 'persist_failed', referralId, error: err };
    }
  }

  // Both sides confirmed by Stripe (or deliberately skipped) → rewarded. The
  // status guard keeps a concurrent retry from double-flipping.
  const { data: flipped, error: flipError } = await service
    .from('referrals')
    .update({ status: 'rewarded', rewarded_at: now.toISOString(), metadata: metadata as ReferralMetadata })
    .eq('id', referralId)
    .eq('status', 'converted')
    .select('id')
    .maybeSingle();
  if (flipError || !flipped) {
    const message = flipError?.message ?? 'referral was no longer converted';
    console.error('[referrals/reward] rewarded flip failed', { referralId, error: message });
    return { outcome: 'persist_failed', referralId, error: message };
  }
  return { outcome: 'rewarded', referralId };
}

/**
 * Webhook entry point: reward the referred family's referral if it is
 * 'converted'. Nothing to do (no referral, or already rewarded) answers null.
 */
export async function rewardConvertedReferral(service: DB, referredFamilyId: string, deps: RewardDeps = {}): Promise<RewardOutcome | null> {
  const { data: ref, error } = await service
    .from('referrals')
    .select('id, status')
    .eq('referred_family_id', referredFamilyId)
    .maybeSingle();
  if (error) throw new Error('Referral lookup failed');
  if (!ref || ref.status !== 'converted') return null;
  return rewardReferral(service, ref.id, deps);
}

// ── Referral email invites ────────────────────────────────────────────────────

export type EmailInviteRecord =
  | { ok: true; rowId: string; created: boolean; remaining: number }
  | { ok: false; reason: 'throttled'; retryAfterSec: number }
  | { ok: false; reason: 'read_failed' | 'write_failed' };

/** How many times a compare-and-set on one referral row is retried before the write is given up. */
const REFERRAL_ROW_CAS_ATTEMPTS = 4;

type ReferralRowVersion = { id: string; metadata: unknown; updated_at: string };

/**
 * Rewrite one referral row's metadata from what it holds NOW, by compare-and-set
 * on `updated_at` (0039's trigger restamps it on every update). The send
 * timestamps live in one jsonb array, so a plain read-modify-write let two
 * concurrent writers each append to the same old array and one stamp vanish —
 * the limit then counted fewer sends than went out. `updated_at` is written
 * explicitly as well; the trigger overrides it with the database's clock.
 * Returns the row it wrote, or none when the write could not land.
 */
async function rewriteReferralMetadata(
  service: DB,
  row: ReferralRowVersion,
  change: (metadata: unknown) => Record<string, unknown>,
): Promise<{ id: string }[]> {
  let current: ReferralRowVersion | null = row;
  for (let attempt = 0; attempt < REFERRAL_ROW_CAS_ATTEMPTS && current; attempt++) {
    let write = service
      .from('referrals')
      .update({ metadata: change(current.metadata) as ReferralMetadata, updated_at: new Date().toISOString() } as never)
      .eq('id', current.id);
    // `updated_at` is NOT NULL with a default (0039), so every stored row has
    // one; a row read without it cannot be guarded and is written as read.
    if (current.updated_at) write = write.eq('updated_at', current.updated_at);
    const { data, error } = await write.select('id');
    if (error) {
      console.error('[referrals/email] referral row write failed', { id: current.id, error });
      return [];
    }
    if (!wroteNoRows(data)) return data as { id: string }[];
    // Someone else wrote the row since it was read: read it again and re-apply.
    const { data: fresh, error: readError } = await service
      .from('referrals').select('id, metadata, updated_at').eq('id', current.id).maybeSingle();
    if (readError) {
      console.error('[referrals/email] referral row re-read failed', { id: current.id, error: readError });
      return [];
    }
    current = fresh as ReferralRowVersion | null;
  }
  console.error('[referrals/email] referral row kept changing under the write', { id: row.id });
  return [];
}

/** The family's sends inside the window, read fresh. Null when the read fails. */
async function referralEmailUsage(service: DB, referrerFamilyId: string, now: Date) {
  const { data: rows, error } = await service
    .from('referrals')
    .select('id, referred_email, status, metadata, updated_at')
    .eq('referrer_family_id', referrerFamilyId);
  if (error) {
    console.error('[referrals/email] referral rows read failed', { familyId: referrerFamilyId, error });
    return null;
  }
  return { rows: rows ?? [], decision: evaluateReferralEmailThrottle(rows ?? [], now) };
}

/**
 * Record that the referrer is emailing `email` their code, subject to the
 * per-family daily limit. Every send is a timestamp on the invited family's
 * row (`metadata.email_sent_at`), which is also what the limit is counted
 * from — so the state lives in a column that already exists. A repeat send
 * to the same address reuses that row rather than adding a second family.
 *
 * THE LIMIT HOLDS UNDER CONCURRENT SENDS. Counting and then writing let every
 * one of N simultaneous sends read "under the limit" and go out — nothing in
 * front of the action rate-limits it — so a member could mail any number of
 * addresses at once from the product's domain. The pre-check stays (it turns
 * the common case away without writing); after the write the family's sends
 * are counted again, and a send that finds the family over the limit takes
 * itself back and is refused. Racers past the limit each see the others, so
 * they may all withdraw — the limit can turn away a send that would have
 * fitted, never let through one that does not.
 */
export async function recordReferralEmailInvite(service: DB, input: {
  referrerFamilyId: string;
  code: string;
  email: string;
  config: ReferralConfig;
  now?: Date;
}): Promise<EmailInviteRecord> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const before = await referralEmailUsage(service, input.referrerFamilyId, now);
  if (!before) return { ok: false, reason: 'read_failed' };
  if (!before.decision.allowed) {
    return { ok: false, reason: 'throttled', retryAfterSec: before.decision.retryAfterSec };
  }

  let recorded: { rowId: string; created: boolean };
  const existing = before.rows.find((r) => (r.referred_email ?? '').toLowerCase() === email);
  if (existing) {
    const written = await rewriteReferralMetadata(service, existing as ReferralRowVersion, (metadata) => withReferralEmailSent(metadata, now));
    if (wroteNoRows(written)) return { ok: false, reason: 'write_failed' };
    recorded = { rowId: existing.id, created: false };
  } else {
    const { data, error: insertError } = await service
      .from('referrals')
      .insert({
        code: input.code,
        referrer_family_id: input.referrerFamilyId,
        referred_family_id: null,
        referred_email: email,
        status: 'pending',
        source: REFERRAL_EMAIL_SOURCE,
        referrer_reward_cents: input.config.referrerRewardCents,
        referred_reward_cents: input.config.referredRewardCents,
        metadata: withReferralEmailSent({}, now) as ReferralMetadata,
      })
      .select('id')
      .maybeSingle();
    if (insertError || !data) {
      console.error('[referrals/email] referral invite insert failed', { familyId: input.referrerFamilyId, error: insertError });
      return { ok: false, reason: 'write_failed' };
    }
    recorded = { rowId: data.id, created: true };
  }

  // Count again, with this send in it. Unreadable is treated as over: the
  // send is taken back rather than mailed on an unchecked count.
  const after = await referralEmailUsage(service, input.referrerFamilyId, now);
  if (!after || after.decision.used > REFERRAL_EMAIL_POLICY.limit) {
    await rollbackReferralEmailInvite(service, { ...recorded, sentAt: now });
    if (!after) return { ok: false, reason: 'read_failed' };
    return { ok: false, reason: 'throttled', retryAfterSec: evaluateReferralEmailThrottle(after.rows, now).retryAfterSec || 1 };
  }
  return { ok: true, ...recorded, remaining: REFERRAL_EMAIL_POLICY.limit - after.decision.used };
}

/** Undo a recorded send whose email never left: drop a fresh row, or the timestamp on a reused one. */
export async function rollbackReferralEmailInvite(service: DB, input: { rowId: string; created: boolean; sentAt: Date }): Promise<void> {
  if (input.created) {
    // A rollback of a row this request inserted, so zero rows deleted is a
    // failed rollback rather than an absence: the invite stays recorded as sent
    // and counts against the family's limit for an email that never left.
    // Logged, not raised, like the update below. Audit C1-S9-64.
    const { data: dropped, error } = await service.from('referrals').delete().eq('id', input.rowId).eq('status', 'pending').select('id');
    if (error || wroteNoRows(dropped)) {
      console.error('[referrals/email] invite rollback delete failed', { id: input.rowId, error: error ?? 'no rows deleted' });
    }
    return;
  }
  const { data, error } = await service.from('referrals').select('id, metadata, updated_at').eq('id', input.rowId).maybeSingle();
  if (error || !data) {
    console.error('[referrals/email] invite rollback read failed', { id: input.rowId, error });
    return;
  }
  const stamp = input.sentAt.toISOString();
  // Only this send's stamp comes off, by compare-and-set: a concurrent send to
  // the same address keeps the stamp it added.
  const unstamped = await rewriteReferralMetadata(service, data as ReferralRowVersion, (metadata) => {
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
    const sent = referralEmailSendTimes(metadata);
    const at = sent.indexOf(stamp);
    return { ...base, email_sent_at: at < 0 ? sent : [...sent.slice(0, at), ...sent.slice(at + 1)] };
  });
  if (wroteNoRows(unstamped)) {
    console.error('[referrals/email] invite rollback update failed', { id: input.rowId, error: 'no rows updated' });
  }
}
