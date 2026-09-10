'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { logAudit } from '@/lib/server/audit';
import { sendEmail } from '@/lib/server/email';
import { APP_URL } from '@/lib/email';
import { completeProfileOnboardingSchema, createFamilySchema, familyDetailsSchema, finalizeOnboardingSchema, inviteMemberActionSchema, inviteSchema, localMemberActionSchema, onboardingProfileSchema, previewCalendarImportSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
import { isValidPin, normalizeAge } from '@/lib/onboarding/pin';
import { buildAppLockConfig } from '@/lib/security/app-lock';
import { cleanGoals, cleanReferralSource } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';
import { recordOnboardingProgress, getOnboardingProgress } from '@/lib/server/onboarding-progress';
import { sendReactEmail } from '@/lib/email';
import { WelcomeEmail } from '@/lib/emails/welcome';
import * as React from 'react';
import { computeCompleteness } from '@/lib/onboarding/completeness';
import { parseIcsResult, toBriefEvents, demoBriefEvents, type IcsImportDisclosure } from '@/lib/onboarding/ics';
import { normalizedImportEvents, type IcsErrorCode } from '@/lib/onboarding/ics-time';
import { buildFirstBrief, briefSummary, type BriefEvent, type FirstBrief } from '@/lib/onboarding/first-brief';
import type { DinnerIdea, DinnerEffort } from '@/lib/onboarding/dinner-ideas';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MemberRole } from '@/lib/constants/roles';
import { describeActionError } from '@/lib/supabase/errors';
import { onboardingItemKey, onboardingRunKey } from '@/lib/onboarding/idempotency';
import { captureSignupReferral } from '@/lib/referrals/signup';
import type { OnboardingAnswers } from '@/lib/onboarding/facts';
import { rememberOnboardingFacts } from '@/lib/onboarding/remember';
import { readCalendarPreview } from '@/lib/onboarding/calendar-state';
import { finishConnectedCalendar, enableConnectedCalendar, validateConnectedCalendarReceipt } from '@/lib/services/onboarding-calendar';
import type { ServiceScope } from '@/lib/services/types';
import type { OnboardingOwner } from '@/lib/onboarding/owner';
import { verifyOnboardingOwner } from '@/lib/onboarding/verify-owner';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

function onboardingFailure(operation: string, error: unknown, fallback: string): { ok: false; error: string } {
  console.error(`[onboarding] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, fallback) };
}

/**
 * Persist the wizard's answers as family memory (M30) without ever being able
 * to fail the finalize. The scope is built here rather than by the caller
 * because finalize has no `requireUserContext` — it runs before the membership
 * a `ServiceScope` would normally be derived from is readable.
 */
async function rememberOnboardingFactsSafely(
  admin: ReturnType<typeof createServiceClient>,
  input: { familyId: string; userId: string; timezone: string; answers: OnboardingAnswers },
): Promise<void> {
  try {
    const { data: member } = await admin
      .from('family_members').select('id')
      .eq('family_id', input.familyId).eq('user_id', input.userId).maybeSingle();
    await rememberOnboardingFacts(
      {
        db: admin,
        familyId: input.familyId,
        userId: input.userId,
        memberId: member?.id ?? null,
        role: 'parent',
        actorKind: 'member',
        tz: input.timezone || 'UTC',
      },
      input.answers,
    );
  } catch (e) {
    console.error('[onboarding] remembering onboarding answers failed', e);
  }
}

/**
 * Load the curated dinner catalog (meal_ideas) the first-run brief draws its 3
 * dinner ideas from. Best-effort: if the table isn't migrated yet the brief just
 * carries no dinner ideas (never blocks onboarding). Capped so the pure picker
 * has plenty of variety without shipping the whole catalog.
 */
async function fetchDinnerCandidates(supabase: SupabaseClient<Database>): Promise<DinnerIdea[]> {
  try {
    const { data, error } = await supabase
      .from('meal_ideas')
      .select('title, cuisine, effort, prep_minutes, description')
      .eq('is_active', true)
      .limit(200);
    if (error || !data) return [];
    return data.map((r) => ({
      title: r.title,
      cuisine: r.cuisine,
      effort: r.effort as DinnerEffort,
      prepMinutes: r.prep_minutes,
      description: r.description ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * VALUE-FIRST (T1): parse the family's existing calendar (pasted .ics or a
 * generated sample week) and compute the instant "first brief" payoff — with NO
 * database write. This is the engine behind the onboarding value step: the user
 * sees their day/week come together before we ask them to configure anything.
 * The parsed events are handed back so the wizard can carry them to finalize,
 * which persists them into the real family's calendar.
 */
export async function previewCalendarImportAction(input: {
  source: 'paste' | 'demo'; icsText?: string; timezone?: string;
}): Promise<Result<{ brief: FirstBrief; events: BriefEvent[]; source: string; disclosure?: IcsImportDisclosure }>> {
  const t = await getTranslations();
  const parsed = previewCalendarImportSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.path[0] === 'timezone'
      ? t('onboardingWizard.invalidPreviewTimezone') : issue?.path[0] === 'icsText'
        ? t('calendarImport.tooManyEvents') : issue?.message ?? 'Invalid calendar import' };
  }

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const now = new Date();
  let events: BriefEvent[] = [];
  let source = parsed.data.source;
  let disclosure: IcsImportDisclosure | undefined;

  if (parsed.data.source === 'demo') {
    events = demoBriefEvents(now, parsed.data.timezone);
    source = 'demo';
  } else {
    const text = (parsed.data.icsText ?? '').trim();
    if (!text) return { ok: false, error: t('actions.pasteYourCalendarSIcs') };
    // Floating times require an explicitly supplied choice, not the schema's legacy UTC default.
    const imported = parseIcsResult(text, { floatingTimezone: input.timezone });
    if (!imported.ok) {
      const keys: Record<IcsErrorCode, string> = {
        invalidCalendar: 'calendarImport.invalidCalendar', invalidDate: 'calendarImport.invalidDate',
        invalidRange: 'calendarImport.invalidRange', invalidDuration: 'calendarImport.invalidDuration',
        unsupportedTimezone: 'calendarImport.unsupportedTimezone', floatingTimezoneRequired: 'calendarImport.floatingTimezoneRequired',
        unsupportedRecurrence: 'calendarImport.unsupportedRecurrence', tooManyEvents: 'calendarImport.tooManyEvents',
      };
      return { ok: false, error: t(keys[imported.code]) };
    }
    // Paste imports listed occurrences, not managed recurring series.
    events = toBriefEvents(imported.events).map(event => ({ ...event, recurring: false }));
    disclosure = imported.disclosure;
    if (events.length === 0) return { ok: false, error: t('actions.noEventsFoundInThat') };
    source = 'paste';
  }

  const dinnerCandidates = await fetchDinnerCandidates(supabase);
  const brief = buildFirstBrief(events, now, dinnerCandidates, parsed.data.timezone);
  return { ok: true, data: { brief, events, source, ...(disclosure ? { disclosure } : {}) } };
}

/**
 * Step 1 of onboarding: capture the account holder's contact details
 * (first/last name, phone, email) into their profile. Email is editable but
 * defaults to the signed-in address. Idempotent — safe to re-run if the user
 * goes back a step.
 */
export async function saveOnboardingProfileAction(input: {
  firstName: string; lastName: string; phone: string; email: string; avatarUrl?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const parsed = onboardingProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const { firstName, lastName, phone, email, avatarUrl } = parsed.data;
  const res = await saveUserProfile(auth.user.id, { firstName, lastName, phone, email, avatarUrl: avatarUrl || null });
  if (!res.ok) return onboardingFailure('profile save', res.error, 'Could not save your profile.');

  await logAudit(supabase, {
    familyId: null, actorId: auth.user.id, action: 'update', resource: 'profiles', resourceId: auth.user.id,
    metadata: { onboarding: true },
  });

  return { ok: true };
}

/** Creates a family, makes the caller its parent (via DB trigger), sets it active. */
export async function createFamilyAction(input: { name: string; timezone: string }): Promise<Result<{ familyId: string }>> {
  const t = await getTranslations();
  const parsed = createFamilySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const { data: family, error } = await supabase
    .from('families')
    .insert({ name: parsed.data.name, timezone: parsed.data.timezone, created_by: auth.user.id })
    .select()
    .single();
  if (error || !family) return error
    ? onboardingFailure('family creation', error, t('actions.couldNotCreateFamily'))
    : { ok: false, error: t('actions.couldNotCreateFamily') };

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
  const { error: memberError } = await supabase.from('family_members').insert({
    family_id: family.id,
    user_id: auth.user.id,
    role: 'parent',
    display_name: displayName,
    is_active: true,
  });
  if (memberError) return onboardingFailure('parent membership creation', memberError, 'Could not add you to the new family.');

  // Make this the active family for the creator.
  const { error: preferencesError } = await supabase.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: family.id },
    { onConflict: 'user_id' },
  );
  if (preferencesError) return onboardingFailure('active family selection', preferencesError, 'Could not select the new family.');

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
  const t = await getTranslations();
  const parsed = familyDetailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

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
  if (error) return onboardingFailure('family details save', error, 'Could not save your family details.');

  await logAudit(supabase, {
    familyId: d.familyId, actorId: auth.user.id, action: 'update', resource: 'family_onboarding',
    resourceId: d.familyId, metadata: { goals: cleanGoals(d.goals), referral_source: cleanReferralSource(d.referralSource) },
  });

  // Feed the marketing engine: enrich the CRM contact with the household + goals
  // + referral source, then fire the welcome automation. Best-effort.
  try {
    const admin = createServiceClient();
    const { data: profile } = await supabase
      .from('profiles').select('display_name, full_name, email, phone').eq('id', auth.user.id).maybeSingle();
    await upsertOnboardingContact(admin, {
      userId: auth.user.id,
      email: profile?.email ?? auth.user.email ?? null,
      firstName: profile?.display_name ?? profile?.full_name ?? null,
      phone: profile?.phone ?? null,
      familyId: d.familyId,
      source: 'onboarding',
      attributes: {
        role: 'parent',
        goals: cleanGoals(d.goals),
        referral_source: cleanReferralSource(d.referralSource),
        household_adults: d.householdAdults,
        household_children: d.householdChildren,
        child_ages: d.childAges,
        region: d.region || null,
        country: d.country || null,
      },
    });
    await fireAutomationEvent(admin, {
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
  const t = await getTranslations();
  const parsed = completeProfileOnboardingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid profile details' };
  const { firstName, age: inputAge, avatarUrl, color, pin } = parsed.data;

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  // 1. Save the profile (name + optional avatar). Sets profiles.full_name so the
  //    family trigger names the parent member correctly when we provision next.
  const profileRes = await saveUserProfile(auth.user.id, {
    firstName, lastName: '', phone: '', avatarUrl: avatarUrl || null,
  });
  if (!profileRes.ok) return onboardingFailure('profile save', profileRes.error, 'Could not save your profile.');

  // 2. Ensure the family space exists (creates parent member + trial sub).
  const ok = await ensureActiveFamily(supabase, auth.user);
  if (!ok) return { ok: false, error: t('actions.couldNotFinishSettingUp') };

  // Steps 3–4 write the member colour and the PIN/age/flag. RLS writes have
  // proven unreliable in this environment (see saveUserProfile + ensure-family),
  // so persist these through the service-role client too — scoped strictly to the
  // already-authenticated user — so the colour and (critically) the PIN actually
  // save instead of silently no-op'ing under RLS.
  const admin = createServiceClient();

  // 3. Resolve the active family + apply the chosen colour to this member.
  const { data: membership, error: membershipError } = await admin
    .from('family_members')
    .select('family_id')
    .eq('user_id', auth.user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (membershipError) return onboardingFailure('membership lookup', membershipError, t('actions.couldNotFinishSettingUp2'));
  const familyId = membership?.family_id ?? '';
  if (!familyId) return { ok: false, error: t('actions.couldNotFinishSettingUp2') };
  if (color) {
    const { error: colorErr } = await admin.from('family_members')
      .update({ color }).eq('user_id', auth.user.id).eq('family_id', familyId);
    if (colorErr) return onboardingFailure('member colour update', colorErr, 'Could not save your profile colour.');
  }

  // 4. Persist age + seeded App Lock + completion flag (merge — never clobber prefs).
  //    The onboarding PIN seeds the App Lock config (same salted-SHA-256 scheme the
  //    Settings card uses) but is stored DISABLED: App Lock stays off until the user
  //    flips it on in Settings — at which point they don't have to re-enter the PIN.
  //    Service-role client so it persists reliably under this env's flaky RLS writes.
  const { data: prefRow, error: prefReadError } = await admin
    .from('user_preferences').select('notification_prefs').eq('user_id', auth.user.id).maybeSingle();
  if (prefReadError) return onboardingFailure('profile preferences lookup', prefReadError, 'Could not finish setting up your profile.');
  const prefs = (prefRow?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...prefs, onboardingComplete: true };
  const age = normalizeAge(inputAge);
  if (age !== null) merged.age = age;
  if (pin && isValidPin(pin)) {
    merged.appLock = { ...(await buildAppLockConfig(pin)), enabled: false };
  }
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, notification_prefs: merged as never },
    { onConflict: 'user_id' },
  );
  if (prefErr) return onboardingFailure('profile preferences save', prefErr, 'Could not finish setting up your profile.');

  await logAudit(supabase, {
    familyId: familyId || null, actorId: auth.user.id,
    action: 'update', resource: 'profiles', resourceId: auth.user.id,
    metadata: { onboarding: 'profile_complete' },
  });

  // 5. Feed the marketing engine: create/enrich the account holder's CRM contact
  //    and fire the welcome ("onboarding_completed") automation. The signed-in
  //    user is the family's parent/admin (ensureActiveFamily provisions the
  //    `parent` member), so the contact is stamped as such. Best-effort — never
  //    blocks the user finishing onboarding.
  await recordOnboardingProgress(admin, {
    userId: auth.user.id,
    familyId: familyId || null,
    source: 'wizard',
    status: 'completed',
    stepsCompleted: ['profile', 'pin'],
    hasPin: !!(pin && isValidPin(pin)),
    completeness: computeCompleteness({
      hasName: firstName.length > 0, hasFamily: true, hasQuestionnaire: false,
      hasGoals: false, valueEngaged: false, memberCount: 0,
      hasPin: !!(pin && isValidPin(pin)), source: 'wizard', status: 'completed',
    }).score,
  });

  // Branded welcome email (best-effort; previously never sent from any path).
  try {
    if (auth.user.email) {
      await sendReactEmail({
        to: auth.user.email,
        subject: 'Welcome to Bubaly 🎉',
        react: React.createElement(WelcomeEmail, { name: firstName || 'there' }),
      });
    }
  } catch (e) {
    console.error('[onboarding] welcome email failed', e);
  }

  try {
    const email = auth.user.email ?? null;
    await upsertOnboardingContact(admin, {
      userId: auth.user.id, email, firstName, familyId: familyId || null,
      source: 'profile_onboarding',
      attributes: { role: 'parent', ...(age !== null ? { age } : {}) },
    });
    await fireAutomationEvent(admin, {
      trigger: 'onboarding_completed',
      email, name: firstName,
      subjectKey: eventSubjectKey('onboarding_completed', [familyId || auth.user.id]),
      context: { familyId: familyId || null, source: 'profile_onboarding' },
    });
  } catch (e) {
    console.error('[onboarding] marketing wiring failed', e);
  }

  return { ok: true, data: { familyId } };
}

/**
 * Reset onboarding for the signed-in account: mark the durable lifecycle row as
 * `reset` and clear the `onboardingComplete` flag in preferences, so the app can
 * route the user back through the setup questionnaire (their EXISTING family is
 * untouched — reset re-opens setup, it never creates a second family or deletes
 * anything). Service-role writes for the same flaky-RLS reason as finalize.
 */
export async function resetOnboardingAction(): Promise<Result> {
  const t = await getTranslations();
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const admin = createServiceClient();

  // 1. Clear the completion flag (merge — never clobber other prefs).
  const { data: prefRow } = await admin
    .from('user_preferences').select('notification_prefs, active_family_id').eq('user_id', auth.user.id).maybeSingle();
  const prefs = (prefRow?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...prefs, onboardingComplete: false };
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, notification_prefs: merged as never },
    { onConflict: 'user_id' },
  );
  if (prefErr) return onboardingFailure('reset preference update', prefErr, 'Could not reset onboarding.');

  // 2. Mark the lifecycle row reset (best-effort, degrades pre-migration).
  await recordOnboardingProgress(admin, {
    userId: auth.user.id,
    familyId: (prefRow?.active_family_id as string | null) ?? null,
    status: 'reset',
  });

  await logAudit(supabase, {
    familyId: (prefRow?.active_family_id as string | null) ?? null, actorId: auth.user.id,
    action: 'update', resource: 'onboarding_progress', resourceId: auth.user.id,
    metadata: { onboarding: 'reset' },
  });

  return { ok: true };
}

/** Adds a managed member with no login (e.g. a young child). */
export async function addLocalMemberAction(input: {
  familyId: string; displayName: string; role: 'child' | 'teen' | 'adult'; color?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const parsed = localMemberActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid member details' };
  const { familyId, displayName: name, role, color } = parsed.data;

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const { error } = await supabase.from('family_members').insert({
    family_id: familyId,
    role,
    display_name: name,
    color: color ?? null,
  });
  if (error) return onboardingFailure('managed member creation', error, 'Could not add that family member.');

  await logAudit(supabase, {
    familyId, actorId: auth.user.id,
    action: 'create', resource: 'family_members', metadata: { display_name: name, role },
  });
  return { ok: true };
}

/** Creates an invite row and emails a join link. */
export async function inviteMemberAction(input: {
  familyId: string; email: string; role: 'adult' | 'teen' | 'caregiver' | 'guest';
}): Promise<Result> {
  const t = await getTranslations();
  const parsedInput = inviteMemberActionSchema.safeParse(input);
  if (!parsedInput.success) return { ok: false, error: parsedInput.error.issues[0]?.message ?? 'Invalid invite' };
  const parsed = inviteSchema.safeParse(parsedInput.data);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid invite' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  const { data: invite, error } = await supabase
    .from('invites')
    .insert({ family_id: parsedInput.data.familyId, email: parsed.data.email, role: parsed.data.role, invited_by: auth.user.id })
    .select('token')
    .single();
  if (error || !invite) return error
    ? onboardingFailure('invite creation', error, t('actions.couldNotCreateInvite'))
    : { ok: false, error: t('actions.couldNotCreateInvite') };

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? APP_URL;
  const link = `${origin}/join?token=${invite.token}`;
  await sendEmail({
    to: parsed.data.email,
    subject: 'You’re invited to a family on Bubaly',
    html: `<p>{t('actions.youVeBeenInvitedTo')}</p><p><a href="${link}">{t('actions.acceptYourInvite')}</a></p>`,
  });

  await logAudit(supabase, {
    familyId: parsedInput.data.familyId, actorId: auth.user.id,
    action: 'create', resource: 'invites', metadata: { email: parsed.data.email, role: parsed.data.role },
  });
  return { ok: true };
}

/**
 * Finalize onboarding: collects everything in-memory across all wizard steps,
 * then writes profile + family + details + members + invites in one action.
 * Abandoning the wizard before this writes NOTHING.
 * Required writes fail closed; welcome email and marketing wiring remain
 * explicitly best-effort because they are not part of the user's account state.
 *
 * The action reconciles the DB trigger's owner member and trial subscription
 * explicitly so it remains correct when a trigger is missing or delayed.
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
  appearance?: { color?: string; age?: number | null; avatarUrl?: string; pin?: string };
  calendarImport?: { source: string; events: BriefEvent[]; receipt?: string };
}, expectedOwner?: OnboardingOwner): Promise<Result<{ familyId: string; brief?: FirstBrief }>> {
  const t = await getTranslations();
  const parsed = finalizeOnboardingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid onboarding data' };
  if (['paste', 'ics'].includes(parsed.data.calendarImport.source)
    && !normalizedImportEvents(parsed.data.calendarImport.events)) return { ok: false, error: t('calendarImport.invalidDate') };

  const supabase = await createServer();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) return { ok: false, error: t('actions.couldNotFinishSettingUp2') };
  if (!auth.user) return { ok: false, error: t('actions.notSignedIn') };

  if (!await verifyOnboardingOwner(supabase, auth.user.id, expectedOwner)) return { ok: false, error: t('onboardingWizard.contextChanged') };

  const { profile, family, details, members, appearance, calendarImport } = parsed.data;
  const connectedReceipt = calendarImport.receipt ? readCalendarPreview(calendarImport.receipt, auth.user.id, calendarImport.events) : null;
  if (calendarImport.receipt && (!connectedReceipt || calendarImport.source !== 'url')) return { ok: false, error: t('connectedCalendar.unavailable') };
  // Provider events may change after a partial Finish and a fresh preview.
  // Managed members/invites belong to the stable wizard, not that snapshot.
  const runKey = onboardingRunKey(auth.user.id, connectedReceipt
    ? { ...parsed.data, calendarImport: { source: 'url', accountId: connectedReceipt.accountId, calendarExternalId: connectedReceipt.calendarExternalId } } : parsed.data);
  const admin = createServiceClient();
  const connectedScope: ServiceScope | null = connectedReceipt ? { db: admin, familyId: connectedReceipt.familyId,
    userId: auth.user.id, memberId: null, actorKind: 'member', role: 'parent', tz: family.timezone } : null;
  if (connectedReceipt && connectedScope) {
    const verified = await validateConnectedCalendarReceipt(connectedScope, connectedReceipt);
    if (!verified.ok) return verified;
  }

  // 1. Save profile (name, phone, email, optional avatar)
  const profileRes = await saveUserProfile(auth.user.id, {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    email: profile.email,
    avatarUrl: profile.avatarUrl || null,
  });
  if (!profileRes.ok) return onboardingFailure('profile save', profileRes.error, 'Could not save your profile.');

  // 2. Resolve the family this onboarding writes to. Guard against minting a
  //    SECOND family: the wizard UI is unreachable once you're in a family (the
  //    layout redirects), but the action itself can be replayed (double-submit,
  //    a retried request, a crafted call). If the caller already has an active
  //    membership:
  //      • their space was auto-provisioned (ensureActiveFamily, e.g. they hit a
  //        protected page before the wizard) → ADOPT it: apply the wizard's name
  //        + timezone and run the rest of the pipeline against it;
  //      • anything else (a completed wizard run, an accepted invite) → treat as
  //        an idempotent re-submit and return that family untouched.
  let familyId: string;
  let newFamily = false; // set when this run creates a brand-new family (a signup)
  const { data: existingMembership, error: membershipLookupError } = await admin
    .from('family_members').select('family_id')
    .eq('user_id', auth.user.id).eq('is_active', true)
    .order('created_at').limit(1).maybeSingle();
  if (membershipLookupError) return onboardingFailure('membership lookup', membershipLookupError, 'Could not check your family setup.');
  if (existingMembership?.family_id) {
    const progress = await getOnboardingProgress(admin, auth.user.id);
    const resumableWizard = progress?.source === 'wizard' && progress.status !== 'completed';
    if (progress?.source !== 'auto_provision' && !resumableWizard) {
      if (connectedReceipt && connectedScope) {
        if (existingMembership.family_id !== connectedReceipt.familyId) return { ok: false, error: t('connectedCalendar.unavailable') };
        const refreshed = await finishConnectedCalendar(connectedScope, connectedReceipt, calendarImport.events);
        if (!refreshed.ok) return refreshed;
        const enabled = await enableConnectedCalendar(connectedScope, connectedReceipt);
        if (!enabled.ok) return enabled;
        return { ok: true, data: { familyId: existingMembership.family_id, brief: buildFirstBrief(calendarImport.events, new Date(), [], family.timezone) } };
      }
      return { ok: true, data: { familyId: existingMembership.family_id } };
    }
    // Preserve the pre-existing marker long enough to make the resume decision
    // above, then claim this request as the active wizard run.
    await recordOnboardingProgress(admin, {
      userId: auth.user.id,
      familyId: existingMembership.family_id,
      source: 'wizard',
      status: 'in_progress',
      stepsCompleted: [],
    });
    familyId = existingMembership.family_id;
    if (connectedReceipt && connectedReceipt.familyId !== familyId) return { ok: false, error: t('connectedCalendar.unavailable') };
    const { error: adoptErr } = await admin.from('families')
      .update({ name: family.name, timezone: family.timezone }).eq('id', familyId);
    if (adoptErr) return onboardingFailure('auto-provisioned family update', adoptErr, t('actions.couldNotFinishSettingUp2'));
  } else {
    // Claim first-family creation under a per-user database lock. This keeps
    // double-submit/retry requests on one family even before the membership
    // trigger is visible to a later request.
    const { data: familyClaims, error: claimErr } = await admin.rpc('onboarding_claim_family', {
      p_user_id: auth.user.id,
      p_name: family.name,
      p_timezone: family.timezone,
    });
    const familyClaim = familyClaims?.[0];
    if (claimErr || !familyClaim) return claimErr
      ? onboardingFailure('family claim', claimErr, t('actions.couldNotFinishSettingUp2'))
      : { ok: false, error: t('actions.couldNotFinishSettingUp2') };
    familyId = familyClaim.family_id;
    newFamily = familyClaim.created;
  }

  // 2b. Explicitly create (or reconcile) the owner's parent membership — do NOT
  //     rely on the `handle_new_family` trigger, which isn't guaranteed to be
  //     installed/active in every environment (see ensure-family.ts: trusting it
  //     is exactly what caused the original onboarding loop). The upsert is
  //     idempotent: if the trigger DID fire we just reconcile name/colour/role.
  //     This is FATAL on failure — a family without its owner as a member would
  //     bounce the user straight back into onboarding.
  const { error: ownerErr } = await admin.from('family_members').upsert(
    {
      family_id: familyId,
      user_id: auth.user.id,
      role: 'parent',
      display_name: profile.firstName.trim(),
      color: appearance.color ?? null,
      is_active: true,
    },
    { onConflict: 'family_id,user_id' },
  );
  if (ownerErr) {
    return onboardingFailure('parent membership upsert', ownerErr, t('actions.couldNotFinishSettingUp2'));
  }

  // 2c. Ensure a trial subscription exists (the trigger may have created one;
  //     only insert when missing so we never duplicate). Non-fatal.
  const { data: existingSub } = await admin
    .from('subscriptions').select('id').eq('family_id', familyId).limit(1);
  if (!existingSub || existingSub.length === 0) {
    const { error: subErr } = await admin.from('subscriptions').insert({
      family_id: familyId, plan: 'free', status: 'trialing',
      current_period_end: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    if (subErr) return onboardingFailure('trial subscription creation', subErr, t('actions.couldNotFinishSettingUp2'));
  }

  // 3. Set this as the active family (service-role + logged: if this silently
  //    failed under RLS the user could land on an auto-provisioned space instead
  //    of the family they just named).
  const { error: activeErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: familyId },
    { onConflict: 'user_id' },
  );
  if (activeErr) return onboardingFailure('active family selection', activeErr, t('actions.couldNotFinishSettingUp2'));

  // 3b. Referral attribution: a `/signup?ref=CODE` visit (cookie, or the auth
  //     metadata the email form wrote) becomes this family's referrals row with
  //     source 'signup_link'. Once per family — applyReferralCode enforces one
  //     referral per referred family, and a replay is answered quietly. Never
  //     blocks onboarding.
  await captureSignupReferral({
    referredFamilyId: familyId,
    referredEmail: profile.email || auth.user.email || null,
    metadataCode: auth.user.user_metadata?.referral_code,
  });

  // 4. Save family details / onboarding questionnaire (service-role + logged —
  //    same flaky-RLS rationale as steps 2/3b: a silent failure here loses the
  //    household details the user just typed).
  const goals = cleanGoals(details.goals);
  const referralSource = cleanReferralSource(details.referralSource);
  const { error: detailsErr } = await admin.from('family_onboarding').upsert(
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
  if (detailsErr) return onboardingFailure('family details save', detailsErr, 'Could not save your family details.');

  // 5. Upsert local (managed) members — no user_id, no login. The stable key
  // makes a retry reconcile the same row after a partial finalization.
  for (const [index, m] of members.entries()) {
    if (m.kind !== 'local') continue;
    const { error: memberErr } = await admin.from('family_members').upsert({
      family_id: familyId,
      role: m.role,
      display_name: m.name,
      color: m.color ?? null,
      birthday: m.birthday || null,
      onboarding_key: onboardingItemKey(runKey, 'member', index, m),
    }, { onConflict: 'family_id,onboarding_key' });
    if (memberErr) return onboardingFailure(`member "${m.name}" creation`, memberErr, 'Could not add all household members.');
  }

  // 6. Create invites and send email join links. A keyed upsert returns a row
  // only when this request created it; existing rows are reused without
  // sending a duplicate email on replay.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? APP_URL;
  for (const [index, m] of members.entries()) {
    if (m.kind !== 'invite') continue;
    const { data: invite, error: inviteErr } = await admin
      .from('invites')
      .upsert({
        family_id: familyId,
        email: m.email,
        role: m.role,
        invited_by: auth.user.id,
        onboarding_key: onboardingItemKey(runKey, 'invite', index, m),
      }, { onConflict: 'family_id,onboarding_key', ignoreDuplicates: true })
      .select('token')
      .maybeSingle();
    if (inviteErr) {
      return inviteErr
        ? onboardingFailure(`invite for ${m.email}`, inviteErr, t('actions.couldNotCreateAllHousehold'))
        : { ok: false, error: t('actions.couldNotCreateAllHousehold') };
    }
    let token = invite?.token;
    if (!token) {
      const { data: existingInvite, error: existingInviteErr } = await admin
        .from('invites')
        .select('token')
        .eq('family_id', familyId)
        .eq('onboarding_key', onboardingItemKey(runKey, 'invite', index, m))
        .maybeSingle();
      if (existingInviteErr || !existingInvite) {
        return existingInviteErr
          ? onboardingFailure(`invite for ${m.email} lookup`, existingInviteErr, t('actions.couldNotCreateAllHousehold'))
          : { ok: false, error: t('actions.couldNotCreateAllHousehold') };
      }
      token = existingInvite.token;
    }
    if (!invite) continue;
    const link = `${origin}/join?token=${token}`;
    await sendEmail({
      to: m.email,
      subject: 'You’re invited to a family on Bubaly',
      html: `<p>{t('actions.youVeBeenInvitedTo')}</p><p><a href="${link}">{t('actions.acceptYourInvite')}</a></p>`,
    });
  }

  // 6a. VALUE-FIRST (T1): persist the calendar the user imported in the value step
  //     into the real family's calendar_events, then record the first-value moment
  //     in onboarding_imports (the seed of the TTFV metric). Required write failures
  //     keep setup retryable and connected-calendar imports paused. The brief is
  //     recomputed server-side (never trust the client) for the durable summary.
  // Compute the first brief server-side (never trust the client) — with the
  // curated dinner ideas — so the Done screen ALWAYS shows a real payoff, even
  // when no calendar was imported (dinner ideas are value on their own).
  const importEvents = (calendarImport?.events ?? []).slice(0, 1000);
  const dinnerCandidates = await fetchDinnerCandidates(supabase);
  const finalBrief = buildFirstBrief(['paste', 'ics'].includes(calendarImport.source)
    ? importEvents.map(event => ({ ...event, recurring: false })) : importEvents, new Date(), dinnerCandidates, family.timezone);

  if (importEvents.length > 0 || connectedReceipt) {
    let importedCount = importEvents.length;
    if (connectedReceipt && connectedScope) {
      const imported = await finishConnectedCalendar(connectedScope, connectedReceipt, importEvents);
      if (!imported.ok) return imported;
    } else {
    const eventRows = importEvents.map((e, index) => ({
      family_id: familyId,
      title: (e.title || 'Untitled').slice(0, 200),
      description: '[Imported during onboarding]',
      location: e.location ?? null,
      starts_at: e.start,
      ends_at: e.end ?? null,
      all_day: !!e.allDay,
      recurrence: 'none' as const,
      category: 'general' as const,
      created_by: auth.user.id,
      onboarding_key: onboardingItemKey(runKey, 'calendar-event', index, e),
    }));
    importedCount = 0;
    for (let i = 0; i < eventRows.length; i += 200) {
      const chunk = eventRows.slice(i, i + 200);
      const { error: evErr } = await admin.from('calendar_events').upsert(chunk, {
        onConflict: 'family_id,onboarding_key',
      });
      if (evErr) return onboardingFailure('calendar import', evErr, 'Could not import your calendar.');
      importedCount += chunk.length;
    }
    }

    try {
      const { error: impErr } = await admin.from('onboarding_imports').upsert({
        family_id: familyId,
        source: (calendarImport?.source as 'ics' | 'paste' | 'url' | 'demo') || 'paste',
        event_count: importedCount,
        today_count: finalBrief.todayCount,
        conflict_count: finalBrief.conflicts.length,
        action_count: finalBrief.actions.length,
        time_saved_minutes: finalBrief.timeSavedMinutes,
        brief: { ...briefSummary(finalBrief), ...(connectedReceipt ? { calendarConnection: { provider: connectedReceipt.provider, accountId: connectedReceipt.accountId, calendarExternalId: connectedReceipt.calendarExternalId } } : {}) } as never,
        created_by: auth.user.id,
        onboarding_key: connectedReceipt ? onboardingItemKey(connectedReceipt.accountId, 'connected-calendar-import', 0, connectedReceipt.calendarExternalId) : onboardingItemKey(runKey, 'calendar-import', 0, {
          source: calendarImport?.source || 'paste',
          events: importEvents,
        }),
      }, { onConflict: 'family_id,onboarding_key' });
      if (impErr) return onboardingFailure('calendar import record', impErr, 'Could not finish importing your calendar.');
    } catch (e) {
      return onboardingFailure('calendar import record', e, 'Could not finish importing your calendar.');
    }
  }

  // 6b. Persist the account holder's age + optional App Lock PIN + the
  //     onboardingComplete flag into the core user_preferences.notification_prefs
  //     jsonb (merge — never clobber). The PIN seeds App Lock DISABLED (same
  //     salted-SHA-256 scheme as Settings); it stays off until the user enables
  //     it, at which point they don't have to re-enter the PIN. Service-role so it
  //     persists reliably under this env's flaky RLS writes.
  const { data: prefRow, error: prefReadError } = await admin
    .from('user_preferences').select('notification_prefs').eq('user_id', auth.user.id).maybeSingle();
  if (prefReadError) return onboardingFailure('onboarding preferences read', prefReadError, t('actions.couldNotFinishSettingUp2'));
  const prefs = (prefRow?.notification_prefs as Record<string, unknown> | null) ?? {};
  const mergedPrefs: Record<string, unknown> = { ...prefs, onboardingComplete: true };
  const age = normalizeAge(appearance.age);
  if (age !== null) mergedPrefs.age = age;
  if (appearance.pin && isValidPin(appearance.pin)) {
    mergedPrefs.appLock = { ...(await buildAppLockConfig(appearance.pin)), enabled: false };
  }
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, notification_prefs: mergedPrefs as never },
    { onConflict: 'user_id' },
  );
  if (prefErr) return onboardingFailure('onboarding preferences save', prefErr, t('actions.couldNotFinishSettingUp2'));

  // 6c. Remember what the family just told us (M30). The answers were going
  //      only into `family_onboarding`, which nothing but marketing segments
  //      read — so Bubaly went on asking a household how many children it has
  //      two minutes after it said. These are the person's own words, so they
  //      land as confirmed facts, and the family's memory switch is honoured
  //      inside the helper. Best-effort by construction: it never throws, and a
  //      memory that missed must not cost someone their finished onboarding.
  //      Kept as one helper call so a parallel change to this action (referral
  //      capture) merges beside it rather than through it.
  await rememberOnboardingFactsSafely(admin, {
    familyId,
    userId: auth.user.id,
    timezone: family.timezone,
    answers: {
      householdAdults: details.householdAdults,
      householdChildren: details.householdChildren,
      childAges: details.childAges,
      region: details.region ?? null,
      country: details.country ?? null,
      goals,
    },
  });

  // 7. Audit
  await logAudit(supabase, {
    familyId, actorId: auth.user.id,
    action: 'create', resource: 'families', resourceId: familyId,
    metadata: { name: family.name, members: members.length },
  });

  // 8. Feed the marketing engine (CRM contact + welcome automation) — best-effort.
  const membersAdded = members.filter((m) => m.kind === 'local').length;
  const membersInvited = members.filter((m) => m.kind === 'invite').length;
  const valueEngaged = importEvents.length > 0;

  // 8a. Record the durable onboarding lifecycle + marketing signal (migration
  //     0159). This is the queryable per-account record that drives re-onboard /
  //     reset detection and marketing segments. We compute a completeness score
  //     from the just-completed wizard so segments can rank engaged sign-ups.
  const completeness = computeCompleteness({
    hasName: profile.firstName.trim().length > 0,
    hasFamily: true,
    hasQuestionnaire: true,
    hasGoals: goals.length > 0,
    valueEngaged,
    memberCount: membersAdded + membersInvited,
    hasPin: !!(appearance.pin && isValidPin(appearance.pin)),
    source: 'wizard',
    status: 'completed',
  }).score;
  await recordOnboardingProgress(admin, {
    userId: auth.user.id,
    familyId,
    source: 'wizard',
    status: 'completed',
    stepsCompleted: ['profile', 'family', 'value', 'about', 'members', 'pin'],
    valueEngaged,
    importSource: calendarImport?.source || null,
    eventsImported: importEvents.length,
    timeSavedMinutes: finalBrief.timeSavedMinutes,
    goals,
    referralSource,
    householdAdults: details.householdAdults,
    householdChildren: details.householdChildren,
    membersAdded,
    membersInvited,
    hasPin: !!(appearance.pin && isValidPin(appearance.pin)),
    completeness,
  });
  if (connectedReceipt && connectedScope) {
    const enabled = await enableConnectedCalendar(connectedScope, connectedReceipt);
    if (!enabled.ok) return enabled;
  }

  // 8b. Send the branded welcome email (best-effort — the template existed but
  //     was never wired to a completion path, so no one ever received it).
  try {
    const to = profile.email || auth.user.email;
    if (to) {
      await sendReactEmail({
        to,
        subject: 'Welcome to Bubaly 🎉',
        react: React.createElement(WelcomeEmail, { name: profile.firstName.trim() || 'there' }),
      });
    }
  } catch (e) {
    console.error('[onboarding] welcome email failed', e);
  }

  try {
    const { data: prof } = await supabase
      .from('profiles').select('display_name, full_name, email, phone').eq('id', auth.user.id).maybeSingle();
    await upsertOnboardingContact(admin, {
      userId: auth.user.id,
      email: prof?.email ?? profile.email ?? auth.user.email ?? null,
      firstName: prof?.display_name ?? profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      phone: prof?.phone ?? profile.phone ?? null,
      familyId,
      source: 'onboarding',
      attributes: {
        role: 'parent',
        goals,
        referral_source: referralSource,
        household_adults: details.householdAdults,
        household_children: details.householdChildren,
        child_ages: details.childAges,
        members_invited: membersInvited,
        members_added: membersAdded,
        // Value-step engagement — the strongest activation signal — now segmentable.
        value_engaged: valueEngaged,
        events_imported: importEvents.length,
        time_saved_minutes: finalBrief.timeSavedMinutes,
        onboarding_completeness: completeness,
      },
    });
    await fireAutomationEvent(admin, {
      trigger: 'onboarding_completed',
      email: prof?.email ?? profile.email ?? auth.user.email ?? null,
      name: prof?.display_name ?? prof?.full_name ?? profile.firstName ?? null,
      subjectKey: eventSubjectKey('onboarding_completed', [familyId]),
      context: { familyId, goals, referral_source: referralSource, value_engaged: valueEngaged, completeness },
    });
  } catch (e) {
    console.error('[onboarding] automation event failed', e);
  }

  // 🎉 Alert the super admin when a NEW family completes onboarding (a signup).
  // Best-effort; only for freshly-created families (not idempotent re-submits).
  if (newFamily) {
    try {
      const { recordAdminNotification } = await import('@/lib/admin/notify');
      await recordAdminNotification(admin, {
        kind: 'family_signup',
        title: `New family signed up: ${family.name}`,
        body: `${details.householdAdults} adult(s) · ${details.householdChildren} kid(s)${referralSource ? ` · via ${referralSource}` : ''}.`,
        url: '/admin/users',
        relatedType: 'family', relatedId: familyId,
        meta: { referralSource, goals },
      });
    } catch (e) {
      console.error('[onboarding] signup admin-notify failed', e);
    }
  }

  return { ok: true, data: { familyId, brief: finalBrief } };
}
