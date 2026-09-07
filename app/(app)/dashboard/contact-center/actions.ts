'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { describeActionError } from '@/lib/supabase/errors';
import { normalizeEmailLocal, isValidEmailLocal } from '@/lib/contact-center/address';
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
  const admin = createServiceClient();
  const channel = await getOrCreateChannelResult(admin, g.familyId);
  if (channel.error) return { ok: false, error: describeActionError(channel.error, t('actions.couldNotLoadTheContact')) };
  const { error } = await admin
    .from('family_contact_channels')
    .update({ email_local: local })
    .eq('family_id', g.familyId);
  if (error) {
    if (error.code === '23505') return { ok: false, error: t('actions.thatAddressIsAlreadyTaken') };
    return { ok: false, error: describeActionError(error, t('actions.couldNotAssignThatAddress')) };
  }
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
  if (input.forwardTo !== undefined) patch.forward_to_phone = input.forwardTo;
  const { error } = await admin.from('family_contact_channels').update(patch).eq('family_id', g.familyId);
  if (error) return { ok: false, error: describeActionError(error, t('actions.couldNotUpdateTheConcierge')) };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}

/** Mark an inbox message read / archived. */
export async function setMessageStatusAction(id: string, status: 'read' | 'archived'): Promise<{ ok: true } | Fail> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const admin = createServiceClient();
  const { error } = await admin
    .from('family_inbox_messages')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId); // scope to the caller's family
  if (error) return { ok: false, error: describeActionError(error, t('actions.couldNotUpdateTheMessage')) };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}
