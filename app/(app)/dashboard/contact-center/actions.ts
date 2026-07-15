'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { describeActionError } from '@/lib/supabase/errors';
import { normalizeEmailLocal, isValidEmailLocal } from '@/lib/contact-center/address';
import { getOrCreateChannel, provisionFamilyNumber } from '@/lib/contact-center/server';

type Fail = { ok: false; error: string };

// The Contact Center is a Family+ capability, and only a parent/admin may change
// the family's central identity. Both are enforced here (server-side) before any
// privileged service-role write.
async function guardParentPlus() {
  const ctx = await requireUserContext();
  if (ctx.active.role !== 'parent') return { ok: false as const, error: 'Only a family admin can manage the Contact Center.' };
  const level = await resolveFamilyPlanLevel(await createServer(), ctx.active.familyId);
  if (level < 2) return { ok: false as const, error: 'The Family Contact Center is a Family+ feature.' };
  return { ok: true as const, familyId: ctx.active.familyId };
}

/** Claim the family's @bubaly.com local-part (globally unique, case-insensitive). */
export async function assignEmailAction(rawLocal: string): Promise<{ ok: true; local: string } | Fail> {
  const g = await guardParentPlus();
  if (!g.ok) return g;
  const local = normalizeEmailLocal(rawLocal);
  if (!isValidEmailLocal(local)) {
    return { ok: false, error: 'Pick 3–30 letters/numbers (dots or dashes allowed), e.g. “smith-family”.' };
  }
  const admin = createServiceClient();
  await getOrCreateChannel(admin, g.familyId);
  const { error } = await admin
    .from('family_contact_channels')
    .update({ email_local: local })
    .eq('family_id', g.familyId);
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'That address is already taken — try another.' };
    return { ok: false, error: describeActionError(error, 'Could not assign that address.') };
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
  const g = await guardParentPlus();
  if (!g.ok) return g;
  const admin = createServiceClient();
  await getOrCreateChannel(admin, g.familyId);
  const patch: Partial<{ ai_concierge_enabled: boolean; ai_greeting: string | null; forward_to_phone: string | null }> = {};
  if (typeof input.enabled === 'boolean') patch.ai_concierge_enabled = input.enabled;
  if (typeof input.greeting === 'string') patch.ai_greeting = input.greeting.trim().slice(0, 500) || null;
  if (input.forwardTo !== undefined) patch.forward_to_phone = input.forwardTo;
  const { error } = await admin.from('family_contact_channels').update(patch).eq('family_id', g.familyId);
  if (error) return { ok: false, error: describeActionError(error, 'Could not update the concierge settings.') };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}

/** Mark an inbox message read / archived. */
export async function setMessageStatusAction(id: string, status: 'read' | 'archived'): Promise<{ ok: true } | Fail> {
  const ctx = await requireUserContext();
  const admin = createServiceClient();
  const { error } = await admin
    .from('family_inbox_messages')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId); // scope to the caller's family
  if (error) return { ok: false, error: describeActionError(error, 'Could not update the message.') };
  revalidatePath('/dashboard/contact-center');
  return { ok: true };
}
