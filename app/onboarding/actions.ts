'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { logAudit } from '@/lib/server/audit';
import { getOrCreateChannelResult } from '@/lib/contact-center/server';
import { provisionFamilyEmailLocal } from '@/lib/contact-center/provision';
import { familyDetailsSchema, finalizeOnboardingSchema, previewCalendarImportSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { isValidPin, normalizeAge } from '@/lib/onboarding/pin';
import { buildAppLockConfig } from '@/lib/security/app-lock';
import { cleanGoals, cleanReferralSource, DEFAULT_OWNER_DISPLAY_NAME } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';
import { recordOnboardingProgress, getOnboardingProgress } from '@/lib/server/onboarding-progress';
import { sendReactEmail } from '@/lib/email';
import { WelcomeEmail } from '@/lib/emails/welcome';
import { InviteEmail } from '@/lib/emails/invite';
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

// REMOVED: saveOnboardingProfileAction, createFamilyAction,
// completeProfileOnboardingAction, addLocalMemberAction, inviteMemberAction.
//
// They were the step-by-step onboarding this file replaced, and nothing had
// imported them since. In a 'use server' module that is not dead code: every
// export is a callable endpoint with its own action id, so five per-step
// writers stayed reachable long after the UI stopped using them —
// contradicting finalizeOnboardingAction's stated guarantee that abandoning
// the wizard writes NOTHING.
//
// Each had also rotted where nobody could see it:
//   • createFamilyAction did insert(families).select().single() on the USER
//     client — the RLS read-back race this repo documents at length in
//     lib/server/ensure-family.ts, so it could only ever half-work.
//   • inviteMemberAction carried the same uninterpolated `{t('key')}` email
//     body fixed below in the wizard's own invite step.
// The schemas they validated against stay in lib/validation.ts; those are
// pure, tested, and still used elsewhere.

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
  // Who the invite is from, for the email's subject and body.
  const inviterName = profile.firstName.trim() || DEFAULT_OWNER_DISPLAY_NAME;
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
    // The branded template every other invite in the product already uses
    // (app/api/email/invite). This site used to build its own two-line HTML
    // string, and an i18n sweep left the calls UNINTERPOLATED inside it:
    //
    //   html: `<p>{t('actions.youVeBeenInvitedTo')}</p>...`
    //
    // `{t('key')}` is JSX syntax. Inside a template literal it is just text, so
    // the first email a new family's spouse ever received read, in full,
    // "{t('actions.youVeBeenInvitedTo')}" — with the accept link labelled
    // "{t('actions.acceptYourInvite')}". It typechecked, it sent, and the keys
    // existed in all eleven catalogues, so the i18n gate passed too.
    await sendReactEmail({
      to: m.email,
      subject: `${inviterName} invited you to join ${family.name} on Bubaly`,
      react: React.createElement(InviteEmail, {
        familyName: family.name, inviterName, token, role: m.role,
      }),
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

  // Give the new family its @bubaly.com address — the one a teacher or a
  // doctor's office can be given so appointment mail reaches the concierge.
  //
  // Best effort, and last, on purpose. The family already exists and setup has
  // already succeeded by this point; a contended name or an unreachable table
  // must not turn a finished onboarding into a retry. An unassigned family
  // simply has no address yet and can claim one in the Contact Center, which is
  // where that control has always been.
  try {
    const channel = await getOrCreateChannelResult(admin, familyId);
    if (!channel.error) {
      const provisioned = await provisionFamilyEmailLocal(admin, familyId, family.name);
      if (!provisioned.assigned && provisioned.reason !== 'already_assigned') {
        console.warn('[onboarding] family email address not assigned', familyId, provisioned.reason);
      }
    }
  } catch (e) {
    console.error('[onboarding] family email provisioning failed', e);
  }

  return { ok: true, data: { familyId, brief: finalBrief } };
}
