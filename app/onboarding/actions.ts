'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendEmail } from '@/lib/server/email';
import { APP_URL } from '@/lib/email';
import { createFamilySchema, familyDetailsSchema, inviteSchema, onboardingProfileSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { cleanGoals, cleanReferralSource } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/**
 * Step 1 of onboarding: capture the account holder's contact details
 * (first/last name, phone, email) into their profile. Email is editable but
 * defaults to the signed-in address. Idempotent — safe to re-run if the user
 * goes back a step.
 */
export async function saveOnboardingProfileAction(input: {
  firstName: string; lastName: string; phone: string; email: string;
}): Promise<Result> {
  const parsed = onboardingProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { firstName, lastName, phone, email } = parsed.data;
  const res = await saveUserProfile(auth.user.id, { firstName, lastName, phone, email });
  if (!res.ok) return res;

  await logAudit(supabase, {
    familyId: null, actorId: auth.user.id, action: 'update', resource: 'profiles', resourceId: auth.user.id,
    metadata: { onboarding: true },
  });

  return { ok: true };
}

/** Creates a family, makes the caller its parent (via DB trigger), sets it active. */
export async function createFamilyAction(input: { name: string; timezone: string }): Promise<Result<{ familyId: string }>> {
  const parsed = createFamilySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { data: family, error } = await supabase
    .from('families')
    .insert({ name: parsed.data.name, timezone: parsed.data.timezone, created_by: auth.user.id })
    .select()
    .single();
  if (error || !family) return { ok: false, error: error?.message ?? 'Could not create family' };

  // Add the creator as a parent member of the new family. Prefer the name they
  // gave in the onboarding profile step, then signup metadata, then email.
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, full_name')
    .eq('id', auth.user.id)
    .maybeSingle();
  const displayName = profile?.display_name
    ?? profile?.full_name
    ?? auth.user.user_metadata?.full_name
    ?? auth.user.email?.split('@')[0]
    ?? 'Parent';
  await supabase.from('family_members').insert({
    family_id: family.id,
    user_id: auth.user.id,
    role: 'parent',
    display_name: displayName,
    is_active: true,
  });

  // Make this the active family for the creator.
  await supabase.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: family.id },
    { onConflict: 'user_id' },
  );

  await logAudit(supabase, {
    familyId: family.id, actorId: auth.user.id,
    action: 'create', resource: 'families', resourceId: family.id,
    metadata: { name: family.name },
  });

  return { ok: true, data: { familyId: family.id } };
}

/**
 * Captures the "About your family" step: household makeup, goals, and how they
 * heard about Bubaly. Upserts one `family_onboarding` row, stamps it complete,
 * and fires the `onboarding_completed` marketing automation (best-effort). RLS
 * (`is_family_member`) guarantees the caller can only write their own family.
 */
export async function saveFamilyDetailsAction(input: {
  familyId: string; householdAdults: number; householdChildren: number; childAges: number[];
  region?: string; postalCode?: string; country?: string;
  goals: string[]; referralSource?: string; referralDetail?: string;
}): Promise<Result> {
  const parsed = familyDetailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const d = parsed.data;
  const { error } = await supabase.from('family_onboarding').upsert(
    {
      family_id: d.familyId,
      household_adults: d.householdAdults,
      household_children: d.householdChildren,
      child_ages: d.childAges,
      region: d.region || null,
      postal_code: d.postalCode || null,
      country: d.country || null,
      goals: cleanGoals(d.goals),
      referral_source: cleanReferralSource(d.referralSource),
      referral_detail: d.referralDetail || null,
      completed_at: new Date().toISOString(),
      created_by: auth.user.id,
    },
    { onConflict: 'family_id' },
  );
  if (error) return { ok: false, error: error.message };

  await logAudit(supabase, {
    familyId: d.familyId, actorId: auth.user.id, action: 'update', resource: 'family_onboarding',
    resourceId: d.familyId, metadata: { goals: cleanGoals(d.goals), referral_source: cleanReferralSource(d.referralSource) },
  });

  // Fire the welcome/onboarding automation in real time (never blocks the user).
  try {
    const { data: profile } = await supabase
      .from('profiles').select('display_name, full_name, email').eq('id', auth.user.id).maybeSingle();
    await fireAutomationEvent(createServiceClient(), {
      trigger: 'onboarding_completed',
      email: profile?.email ?? auth.user.email ?? null,
      name: profile?.display_name ?? profile?.full_name ?? null,
      subjectKey: eventSubjectKey('onboarding_completed', [d.familyId]),
      context: { familyId: d.familyId, goals: cleanGoals(d.goals), referral_source: cleanReferralSource(d.referralSource) },
    });
  } catch (e) {
    console.error('[onboarding] automation event failed', e);
  }

  return { ok: true };
}

/** Adds a managed member with no login (e.g. a young child). */
export async function addLocalMemberAction(input: {
  familyId: string; displayName: string; role: 'child' | 'teen' | 'adult'; color?: string;
}): Promise<Result> {
  const name = input.displayName.trim();
  if (name.length < 1) return { ok: false, error: 'Name is required' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { error } = await supabase.from('family_members').insert({
    family_id: input.familyId,
    role: input.role,
    display_name: name,
    color: input.color ?? null,
  });
  if (error) return { ok: false, error: error.message };

  await logAudit(supabase, {
    familyId: input.familyId, actorId: auth.user.id,
    action: 'create', resource: 'family_members', metadata: { display_name: name, role: input.role },
  });
  return { ok: true };
}

/** Creates an invite row and emails a join link. */
export async function inviteMemberAction(input: {
  familyId: string; email: string; role: 'adult' | 'teen' | 'caregiver' | 'guest';
}): Promise<Result> {
  const parsed = inviteSchema.safeParse({ email: input.email, role: input.role });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid invite' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { data: invite, error } = await supabase
    .from('invites')
    .insert({ family_id: input.familyId, email: parsed.data.email, role: parsed.data.role, invited_by: auth.user.id })
    .select('token')
    .single();
  if (error || !invite) return { ok: false, error: error?.message ?? 'Could not create invite' };

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? APP_URL;
  const link = `${origin}/join?token=${invite.token}`;
  await sendEmail({
    to: parsed.data.email,
    subject: 'You’re invited to a family on Bubaly',
    html: `<p>You’ve been invited to join a family on Bubaly.</p><p><a href="${link}">Accept your invite</a></p>`,
  });

  await logAudit(supabase, {
    familyId: input.familyId, actorId: auth.user.id,
    action: 'create', resource: 'invites', metadata: { email: parsed.data.email, role: parsed.data.role },
  });
  return { ok: true };
}
