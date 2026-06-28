'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendEmail } from '@/lib/server/email';
import { APP_URL } from '@/lib/email';
import { createFamilySchema, familyDetailsSchema, finalizeOnboardingSchema, inviteSchema, onboardingProfileSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
import { isValidPin, normalizeAge } from '@/lib/onboarding/pin';
import { scryptSync, randomBytes } from 'crypto';
import { cleanGoals, cleanReferralSource } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import type { MemberRole } from '@/lib/constants/roles';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/**
 * Step 1 of onboarding: capture the account holder's contact details
 * (first/last name, phone, email) into their profile. Email is editable but
 * defaults to the signed-in address. Idempotent — safe to re-run if the user
 * goes back a step.
 */
export async function saveOnboardingProfileAction(input: {
  firstName: string; lastName: string; phone: string; email: string; avatarUrl?: string;
}): Promise<Result> {
  const parsed = onboardingProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { firstName, lastName, phone, email, avatarUrl } = parsed.data;
  const res = await saveUserProfile(auth.user.id, { firstName, lastName, phone, email, avatarUrl: avatarUrl || null });
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

/** Hash a PIN (scrypt, random salt) → "salt:hash" hex. Stored, never logged. */
function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * The lightweight onboarding journey from the product mockups (post sign-in):
 * "Create your profile" (avatar, name, age, color) → "Create a PIN" → done.
 * One atomic write: saves the profile, auto-provisions the family space (so the
 * user lands straight on the dashboard — no separate setup wizard, no loop),
 * stores the member's color, and persists age + a hashed PIN + an
 * `onboardingComplete` flag in the core `user_preferences.notification_prefs`
 * jsonb (no migration). Idempotent.
 */
export async function completeProfileOnboardingAction(input: {
  firstName: string; age?: number | string | null; avatarUrl?: string; color?: string; pin?: string;
}): Promise<Result<{ familyId: string }>> {
  const firstName = (input.firstName ?? '').trim();
  if (firstName.length < 1) return { ok: false, error: 'Please add your name.' };
  if (input.pin && !isValidPin(input.pin)) return { ok: false, error: 'Your PIN must be 4 digits.' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  // 1. Save the profile (name + optional avatar). Sets profiles.full_name so the
  //    family trigger names the parent member correctly when we provision next.
  const profileRes = await saveUserProfile(auth.user.id, {
    firstName, lastName: '', phone: '', avatarUrl: input.avatarUrl || null,
  });
  if (!profileRes.ok) return profileRes;

  // 2. Ensure the family space exists (creates parent member + trial sub).
  const ok = await ensureActiveFamily(supabase, auth.user);
  if (!ok) return { ok: false, error: 'Could not finish setting up your space. Please try again.' };

  // Steps 3–4 write the member colour and the PIN/age/flag. RLS writes have
  // proven unreliable in this environment (see saveUserProfile + ensure-family),
  // so persist these through the service-role client too — scoped strictly to the
  // already-authenticated user — so the colour and (critically) the PIN actually
  // save instead of silently no-op'ing under RLS.
  const admin = createServiceClient();

  // 3. Resolve the active family + apply the chosen colour to this member.
  const { data: membership } = await admin
    .from('family_members')
    .select('family_id')
    .eq('user_id', auth.user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  const familyId = membership?.family_id ?? '';
  if (input.color) {
    const { error: colorErr } = await admin.from('family_members')
      .update({ color: input.color }).eq('user_id', auth.user.id);
    if (colorErr) console.error('[onboarding] member colour update failed', colorErr);
  }

  // 4. Persist age + hashed PIN + completion flag (merge — never clobber prefs).
  const { data: prefRow } = await admin
    .from('user_preferences').select('notification_prefs').eq('user_id', auth.user.id).maybeSingle();
  const prefs = (prefRow?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...prefs, onboardingComplete: true };
  const age = normalizeAge(input.age);
  if (age !== null) merged.age = age;
  if (input.pin && isValidPin(input.pin)) merged.pinHash = hashPin(input.pin);
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, notification_prefs: merged as never },
    { onConflict: 'user_id' },
  );
  if (prefErr) console.error('[onboarding] preferences (PIN/age/flag) save failed', prefErr);

  await logAudit(supabase, {
    familyId: familyId || null, actorId: auth.user.id,
    action: 'update', resource: 'profiles', resourceId: auth.user.id,
    metadata: { onboarding: 'profile_complete' },
  });

  return { ok: true, data: { familyId } };
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

/**
 * Atomic onboarding: collects everything in-memory across all wizard steps,
 * then writes profile + family + details + members + invites in one action.
 * Abandoning the wizard before this writes NOTHING.
 *
 * The DB trigger `handle_new_family` auto-creates the owner as a `parent`
 * member and provisions a trial subscription on family INSERT, so we skip
 * inserting the parent member ourselves.
 */
export async function finalizeOnboardingAction(input: {
  profile: { firstName: string; lastName: string; phone: string; email: string; avatarUrl?: string };
  family: { name: string; timezone: string };
  details: {
    householdAdults: number; householdChildren: number; childAges: number[];
    region?: string; postalCode?: string; country?: string;
    goals: string[]; referralSource?: string; referralDetail?: string;
  };
  members: Array<
    | { kind: 'local'; name: string; role: MemberRole; birthday?: string; color?: string }
    | { kind: 'invite'; email: string; role: MemberRole }
  >;
}): Promise<Result<{ familyId: string }>> {
  const parsed = finalizeOnboardingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid onboarding data' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { profile, family, details, members } = parsed.data;

  // 1. Save profile (name, phone, email, optional avatar)
  const profileRes = await saveUserProfile(auth.user.id, {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    email: profile.email,
    avatarUrl: profile.avatarUrl || null,
  });
  if (!profileRes.ok) return profileRes;

  // 2. Create the family — DB trigger creates parent member + trial subscription.
  //    Use the service-role client for the insert: the families_select RLS policy
  //    (is_family_member, STABLE) would otherwise filter the RETURNING row before
  //    the trigger's membership is visible to the statement snapshot, so the
  //    insert would come back empty. See lib/server/ensure-family.ts for the full
  //    explanation of this trigger + RLS + RETURNING race.
  const admin = createServiceClient();
  const { data: familyRow, error: famErr } = await admin
    .from('families')
    .insert({ name: family.name, timezone: family.timezone, created_by: auth.user.id })
    .select()
    .single();
  if (famErr || !familyRow) return { ok: false, error: famErr?.message ?? 'Could not create family' };

  const familyId = familyRow.id;

  // 3. Set this as the active family
  await supabase.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: familyId },
    { onConflict: 'user_id' },
  );

  // 4. Save family details / onboarding questionnaire
  const goals = cleanGoals(details.goals);
  const referralSource = cleanReferralSource(details.referralSource);
  await supabase.from('family_onboarding').upsert(
    {
      family_id: familyId,
      household_adults: details.householdAdults,
      household_children: details.householdChildren,
      child_ages: details.childAges,
      region: details.region || null,
      postal_code: details.postalCode || null,
      country: details.country || null,
      goals,
      referral_source: referralSource,
      referral_detail: details.referralDetail || null,
      completed_at: new Date().toISOString(),
      created_by: auth.user.id,
    },
    { onConflict: 'family_id' },
  );

  // 5. Insert local (managed) members — no user_id, no login
  for (const m of members) {
    if (m.kind !== 'local') continue;
    await supabase.from('family_members').insert({
      family_id: familyId,
      role: m.role,
      display_name: m.name,
      color: m.color ?? null,
      birthday: m.birthday || null,
    });
  }

  // 6. Create invites and send email join links
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? APP_URL;
  for (const m of members) {
    if (m.kind !== 'invite') continue;
    const { data: invite } = await supabase
      .from('invites')
      .insert({ family_id: familyId, email: m.email, role: m.role, invited_by: auth.user.id })
      .select('token')
      .single();
    if (invite) {
      const link = `${origin}/join?token=${invite.token}`;
      await sendEmail({
        to: m.email,
        subject: 'You’re invited to a family on Bubaly',
        html: `<p>You’ve been invited to join a family on Bubaly.</p><p><a href="${link}">Accept your invite</a></p>`,
      });
    }
  }

  // 7. Audit
  await logAudit(supabase, {
    familyId, actorId: auth.user.id,
    action: 'create', resource: 'families', resourceId: familyId,
    metadata: { name: family.name, members: members.length },
  });

  // 8. Fire onboarding_completed automation (best-effort)
  try {
    const { data: prof } = await supabase
      .from('profiles').select('display_name, full_name, email').eq('id', auth.user.id).maybeSingle();
    await fireAutomationEvent(createServiceClient(), {
      trigger: 'onboarding_completed',
      email: prof?.email ?? auth.user.email ?? null,
      name: prof?.display_name ?? prof?.full_name ?? null,
      subjectKey: eventSubjectKey('onboarding_completed', [familyId]),
      context: { familyId, goals, referral_source: referralSource },
    });
  } catch (e) {
    console.error('[onboarding] automation event failed', e);
  }

  return { ok: true, data: { familyId } };
}
