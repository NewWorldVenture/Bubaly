'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { toE164 } from '@/lib/guardian/phone';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { normalizeEmailLocal, isValidEmailLocal, isReservedEmailLocal } from '@/lib/contact-center/address';
import { getOrCreateChannelResult, provisionFamilyNumber } from '@/lib/contact-center/server';

type Fail = { ok: false; error: string };

// The Contact Center is a Family+ capability, and only a parent/admin may change
// the family's central identity. Both are enforced here (server-side) before any
// privileged service-role write.
async function guardParentPlus() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (ctx.active.role !== 'parent') return { ok: false as const, error: t('actions.onlyAFamilyAdminCan') };
  const level = await resolveFamilyPlanLevel(await createServer(), ctx.active.familyId);
  if (level < 2) return { ok: false as const, error: t('actions.theFamilyContactCenterIs') };
  return { ok: true as const, familyId: ctx.active.familyId };
}

/** Claim the family's @bubaly.com local-part (globally unique, case-insensitive). */
export async function assignEmailAction(rawLocal: string): Promise<{ ok: true; local: string } | Fail> {
  const t = await getTranslations();
  const g = await guardParentPlus();
  if (!g.ok) return g;
  const local = normalizeEmailLocal(rawLocal);
  if (!isValidEmailLocal(local)) {
    return { ok: false, error: 'Pick 3–30 letters/numbers (dots or dashes allowed), e.g. “smith-family”.' };
  }
  // Reserved names are refused BEFORE the unique index is consulted. Uniqueness
  // alone would not protect these: the first family to ask would simply get
  // support@bubaly.com, and every message meant for the company with it.
  if (isReservedEmailLocal(local)) {
    return { ok: false, error: 'That address is reserved for Bubaly. Please choose another.' };
  }
  const admin = createServiceClient();
  const channel = await getOrCreateChannelResult(admin, g.familyId);
  if (channel.error) return { ok: false, error: describeActionError(channel.error, t('actions.couldNotLoadTheContact')) };
  // This returns `{ ok: true, local }` — it tells the family the address they
  // now have. An update that matched no row handed them an address that was
  // never stored, and mail sent to it goes nowhere. The same shape as the
  // marketplace handoff code in C1-S9-16: a value returned to the user that the
  // database never accepted. Audit C1-S9-47.
  const { data: assigned, error } = await admin
    .from('family_contact_channels')
    .update({ email_local: local })
    .eq('family_id', g.familyId).select('family_id');
  if (error) {
    if (error.code === '23505') return { ok: false, error: t('actions.thatAddressIsAlreadyTaken') };
    return { ok: false, error: describeActionError(error, t('actions.couldNotAssignThatAddress')) };
  }
  if (wroteNoRows(assigned)) return { ok: false, error: t('actions.couldNotAssignThatAddress') };
  revalidatePath('/dashboard/contact-center');
  return { ok: true, local };
}

/** Provision (or request) the family's dedicated phone number. */
export async function provisionNumberAction(areaCode?: string): Promise<{ ok: true; phoneNumber?: string; pending?: boolean } | Fail> {
  const g = await guardParentPlus();
  if (!g.ok) return g;
  const admin = createServiceClient();
  const res = await provisionFamilyNumber(admin, g.familyId, areaCode?.trim() || undefined);
  revalidatePath('/dashboard/contact-center');
  if (res.ok) return { ok: true, phoneNumber: res.phoneNumber };
  if (res.skipped) return { ok: true, pending: true };
  return { ok: false, error: res.error ?? 'Could not provision a number.' };
}

/** Toggle the AI concierge and set its greeting / human fallback. */
export async function updateConciergeAction(input: {
  enabled?: boolean; greeting?: string; forwardTo?: string | null;
}): Promise<{ ok: true } | Fail> {
  const t = await getTranslations();
  const g = await guardParentPlus();
  if (!g.ok) return g;
  const admin = createServiceClient();
  const channel = await getOrCreateChannelResult(admin, g.familyId);
  if (channel.error) return { ok: false, error: describeActionError(channel.error, t('actions.couldNotLoadTheContact')) };
  const patch: Partial<{ ai_concierge_enabled: boolean; ai_greeting: string | null; forward_to_phone: string | null }> = {};
  if (typeof input.enabled === 'boolean') patch.ai_concierge_enabled = input.enabled;
  if (typeof input.greeting === 'string') patch.ai_greeting = input.greeting.trim().slice(0, 500) || null;
  if (input.forwardTo !== undefined) {
    // The greeting beside this is trimmed and capped; this was stored raw, and
    // unlike the greeting it is DIALLED — it reaches `<Dial>` in the voice
    // route and Twilio's `To` in three escalation paths. Normalise to E.164 or
    // refuse, rather than storing something that is not a number. Clearing the
    // fallback stays possible: an empty value is null, not an error.
    // Audit C1-S7-05.
    const cleared = input.forwardTo === null || input.forwardTo.trim() === '';
    const normalized = cleared ? null : toE164(input.forwardTo);
    if (!cleared && !normalized) return { ok: false, error: t('actions.enterAValidPhoneNumber') };
    patch.forward_to_phone = normalized;
  }
  const { data: patched, error } = await admin.from('family_contact_channels').update(patch).eq('family_id', g.familyId).select('family_id');
  if (error) return { ok: false, error: describeActionError(error, t('actions.couldNotUpdateTheConcierge')) };
  // Includes call forwarding: a parent who thinks the family line now forwards
  // to their mobile, and it does not, misses the call this feature exists for.
  if (wroteNoRows(patched)) return { ok: false, error: t('actions.couldNotUpdateTheConcierge') };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}

/** Mark an inbox message read / archived. */
export async function setMessageStatusAction(id: string, status: 'read' | 'archived'): Promise<{ ok: true } | Fail> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const admin = createServiceClient();
  const { data: updated, error } = await admin
    .from('family_inbox_messages')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId) // scope to the caller's family
    .select('id');
  if (error) return { ok: false, error: describeActionError(error, t('actions.couldNotUpdateTheMessage')) };
  if (wroteNoRows(updated)) return { ok: false, error: t('actions.couldNotUpdateTheMessage') };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}
