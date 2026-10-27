'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { logAudit } from '@/lib/server/audit';
import { getOrCreateChannelResult } from '@/lib/contact-center/server';
import { provisionFamilyEmailLocal } from '@/lib/contact-center/provision';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { FAMILY_EMAIL_MIN_PLAN_LEVEL } from '@/lib/constants/plans';
import { familyDetailsSchema, finalizeOnboardingSchema, previewCalendarImportSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { isValidPin, normalizeAge } from '@/lib/onboarding/pin';
import { buildAppLockConfig } from '@/lib/security/app-lock';
import { readAppLockRecord, replaceAppLockRecord } from '@/lib/security/app-lock-store';
import { cleanGoals, cleanReferralSource, DEFAULT_OWNER_DISPLAY_NAME } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';
import { recordOnboardingProgress, readOnboardingProgress } from '@/lib/server/onboarding-progress';
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
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { onboardingItemKey, onboardingRunKey } from '@/lib/onboarding/idempotency';
import { captureSignupReferral } from '@/lib/referrals/signup';
import type { OnboardingAnswers } from '@/lib/onboarding/facts';
import { rememberOnboardingFacts } from '@/lib/onboarding/remember';
import { readCalendarPreview } from '@/lib/onboarding/calendar-state';
import { finishConnectedCalendar, enableConnectedCalendar, validateConnectedCalendarReceipt } from '@/lib/services/onboarding-calendar';
import type { ServiceScope } from '@/lib/services/types';
import type { OnboardingOwner } from '@/lib/onboarding/owner';
import { verifyOnboardingOwner } from '@/lib/onboarding/verify-owner';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { isChildLoginAccount, memberHasAKidLogin } from '@/lib/server/child-account';
import { requireUserContext } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';
import { recordActivationServer } from '@/lib/analytics/activation-server';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** An invite finalize created but did not email (see ONBOARDING_INVITE_EMAIL_CAP). */
export type UnsentInvite = { id: string; email: string };

/**
 * The most invite EMAILS one finalize may send. The schema admits 30 drafted
 * members, and every invite used to mail a caller-chosen address from
 * Bubaly's sender with a caller-chosen family name in the subject, with no
 * limiter at all — so a fresh account was a 30-message spam relay. Invite
 * rows past the cap (or refused by a limiter, or rejected by the mail
 * provider) are still created but NOT emailed. Finalize returns them as
 * `unsentInvites`, and the Done screen offers a Send button for each, which
 * goes through /api/email/invite and its own limiter. Nothing else re-sends
 * them.
 */
const ONBOARDING_INVITE_EMAIL_CAP = 5;

/**
 * The welcome email goes once per ACCOUNT, and the record of it is kept in the
 * auth user's app_metadata, which only the service role can write (the kid
 * login's marker lives there too). The limiter bucket used to be that record,
 * with a 30-day window, but rate_limit_prune (0156) deletes buckets a day old
 * and the automations cron runs it daily — so a replayed finish could send
 * another welcome about once a day. The limiter stays for what it can do:
 * stop two finishes racing each other from both sending before either has
 * written the record.
 */
const WELCOME_EMAIL_SENT_KEY = 'welcome_email_sent_at';
const WELCOME_EMAIL_RACE_WINDOW_MS = 24 * 3_600_000;

/**
 * TTFV: a calendar the wizard imported — pasted, an ICS file or link, or a
 * connected provider calendar, not the sample — is the household's `calendar_imported`
 * milestone, the one the feeds action records for an ICS feed added later.
 * The wizard recorded nothing, so the funnel's "Imported a calendar" and
 * "Calendar imported (session 1)", rates over every household, counted only
 * those feeds. Once per household, timed from its sign-up as the feeds
 * action's is; best-effort, like every milestone (recordActivationServer
 * swallows its own failures).
 */
async function recordWizardCalendarImport(admin: ReturnType<typeof createServiceClient>, userId: string, familyId: string): Promise<void> {
  const { data: household, error: householdError } = await admin.from('families').select('created_at').eq('id', familyId).maybeSingle();
  // Unread, the milestone is recorded untimed rather than timed from a guess.
  if (householdError) console.error('[onboarding] household sign-up time read failed; recording the import untimed', { familyId, error: householdError });
  await recordActivationServer({ userId, familyId, milestone: 'calendar_imported', signupAtIso: householdError ? null : household?.created_at ?? null });
}

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
 * and fires the `onboarding_completed` marketing automation (best-effort).
 *
 * The household's answers are a manager's to give. The family used to come
 * from the input and no role was checked, and family_onboarding's policy is
 * any member (0052; 0481 blocks only guests), so a child, teen or caregiver
 * rewrote the household's adults, children and goals and then, through the
 * service role, the owner's CRM contact. The family is now the caller's
 * ACTIVE one, a parent or adult is required, and a familyId that is not it
 * is refused rather than quietly redirected.
 */
export async function saveFamilyDetailsAction(input: {
  familyId: string; householdAdults: number; householdChildren: number; childAges: number[];
  region?: string; postalCode?: string; country?: string;
  goals: string[]; referralSource?: string; referralDetail?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const parsed = familyDetailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid details' };

  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentOrGuardian') };
  if (parsed.data.familyId !== ctx.active.familyId) return { ok: false, error: t('onboardingWizard.contextChanged') };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user || auth.user.id !== ctx.user.id) return { ok: false, error: t('actions.notSignedIn') };

  const d = { ...parsed.data, familyId: ctx.active.familyId };
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
      // The VERIFIED address first. `profiles.email` is a plain text column the
      // owner may rewrite at will (profiles_update_self constrains the row, not
      // its columns), and downstream this value is the key that decides WHICH
      // crm_contacts row gets overwritten — through the service role, past
      // admin-only RLS. Preferring it let someone point their profile at a
      // stranger's address, or at a LIKE wildcard, and take that contact over.
      email: auth.user.email ?? profile?.email ?? null,
      firstName: profile?.display_name ?? profile?.full_name ?? null,
      phone: profile?.phone ?? null,
      familyId: d.familyId,
      source: 'onboarding',
      attributes: {
        // The caller's own role, not an assumed 'parent': an adult answering
        // for the household is recorded as the adult they are.
        role: ctx.active.role,
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
      // Verified first here too: runSteps sends `to: recipient.email` through
      // Resend from the product's own FROM_EMAIL, so an unverified writable
      // column decides who receives branded mail on our behalf.
      email: auth.user.email ?? profile?.email ?? null,
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

  // 1. Clear the completion flag through the one merge every other writer of
  //    this blob uses. It used to read the row with its error dropped, so a
  //    failed read became `{}` and the upsert below replaced the WHOLE
  //    notification_prefs blob — App Lock, navigation, shortcuts, moment prep
  //    and the referral dismissal — with `{ onboardingComplete: false }`, and
  //    the screen said "Onboarding reset". mergeNotificationPrefs refuses to
  //    merge into an unread row and compare-and-sets on updated_at, so a
  //    concurrent App Lock or shortcut save is not overwritten either.
  const cleared = await mergeNotificationPrefs(admin, auth.user.id, (prefs) => ({ ...prefs, onboardingComplete: false }));
  if (!cleared.ok) {
    return onboardingFailure(`reset preference update (${cleared.reason})`, cleared.error ?? new Error(cleared.reason), 'Could not reset onboarding.');
  }

  // 2. Mark the lifecycle row reset (best-effort, degrades pre-migration).
  //    `active_family_id` is the user's own preference row, so it names
  //    whatever family they set it to. Written straight into
  //    onboarding_progress.family_id by the service role, it walked around the
  //    column 0454 takes away from clients — the pointer SEC-018 turned on. Only
  //    a family the user is an active member of is recorded.
  //
  //    A read that did not answer is not "no family": both errors used to be
  //    dropped, and the reset then recorded a NULL family over the one the row
  //    named. When either read fails the family is left as it is (undefined
  //    leaves the column untouched) and the failure is logged.
  const { data: prefRow, error: prefReadError } = await admin
    .from('user_preferences').select('active_family_id').eq('user_id', auth.user.id).maybeSingle();
  if (prefReadError) console.error('[onboarding] reset active family read failed', prefReadError);
  const preferred = (prefRow?.active_family_id as string | null) ?? null;
  const { data: membership, error: membershipError } = preferred
    ? await admin.from('family_members').select('family_id')
      .eq('user_id', auth.user.id).eq('family_id', preferred).eq('is_active', true).maybeSingle()
    : { data: null, error: null };
  if (membershipError) console.error('[onboarding] reset membership read failed', membershipError);
  const ownFamilyId = prefReadError || membershipError ? undefined : membership?.family_id ?? null;
  await recordOnboardingProgress(admin, {
    userId: auth.user.id,
    familyId: ownFamilyId,
    status: 'reset',
  });

  // The service client, not the caller's: this is a row the SERVER authors about
  // a reset it just performed, and the family may be null for a user who has
  // not joined a household yet. 0300 pins `audit_insert` to
  // `is_family_member(family_id) and actor_id = auth.uid()` and drops the
  // `family_id is null` branch — this was the one client-side caller that used it,
  // and `admin` was already in scope above. Every other null-family audit writer
  // (the admin actions, the benchmarks export) was on the service role already.
  //
  // The family it names is the VERIFIED one, not `active_family_id`: the service
  // role writes whatever it is given, so recording the unverified preference
  // would launder a pointer into the audit trail with no policy to catch it.
  await logAudit(admin, {
    familyId: ownFamilyId ?? null, actorId: auth.user.id,
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
    | { kind: 'local'; id?: string; name: string; role: MemberRole; birthday?: string; color?: string }
    | { kind: 'invite'; id?: string; email: string; role: MemberRole }
  >;
  appearance?: { color?: string; age?: number | null; avatarUrl?: string; pin?: string };
  calendarImport?: { source: string; events: BriefEvent[]; receipt?: string };
}, expectedOwner?: OnboardingOwner): Promise<Result<{ familyId: string; brief?: FirstBrief; unsentInvites?: UnsentInvite[] }>> {
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

  // 1. Save profile (name, phone, optional avatar). The email stored is the
  //    ACCOUNT's address, never the form's: `profile.email` is whatever the
  //    caller typed (the schema checks only its shape), and profiles.email is
  //    what journey-recovery later mails, so an unverified value there was a
  //    stranger's inbox on Bubaly's sender.
  const profileRes = await saveUserProfile(auth.user.id, {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    email: auth.user.email ?? null,
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
    .from('family_members').select('family_id, role')
    .eq('user_id', auth.user.id).eq('is_active', true)
    .order('created_at').limit(1).maybeSingle();
  if (membershipLookupError) return onboardingFailure('membership lookup', membershipLookupError, 'Could not check your family setup.');
  if (existingMembership?.family_id) {
    // An unread progress row is not an absent one. Read as null it took the
    // "idempotent re-submit" branch below and returned success having written
    // nothing — details, members, invites, preferences — while the wizard
    // showed Done and deleted the draft. Only a confirmed answer decides.
    const progressRead = await readOnboardingProgress(admin, auth.user.id);
    if (progressRead.error) return onboardingFailure('onboarding progress read', progressRead.error, t('actions.couldNotFinishSettingUp2'));
    const progress = progressRead.row;
    const resumableWizard = progress?.source === 'wizard' && progress.status !== 'completed';
    if (progress?.source !== 'auto_provision' && !resumableWizard) {
      if (connectedReceipt && connectedScope) {
        if (existingMembership.family_id !== connectedReceipt.familyId) return { ok: false, error: t('connectedCalendar.unavailable') };
        const refreshed = await finishConnectedCalendar(connectedScope, connectedReceipt, calendarImport.events);
        if (!refreshed.ok) return refreshed;
        const enabled = await enableConnectedCalendar(connectedScope, connectedReceipt);
        if (!enabled.ok) return enabled;
        await recordWizardCalendarImport(admin, auth.user.id, existingMembership.family_id);
        return { ok: true, data: { familyId: existingMembership.family_id, brief: buildFirstBrief(calendarImport.events, new Date(), [], family.timezone) } };
      }
      return { ok: true, data: { familyId: existingMembership.family_id } };
    }
    // ADOPT only the caller's own first family. The oldest active membership
    // is not necessarily that: an auto-provisioned user who later joined
    // another household as a guest and deactivated their own row would
    // otherwise have that household renamed and be upserted into it as a
    // PARENT with the service role below. The same three facts
    // prepareCalendarFamily / verifyOnboardingOwner already insist on: the
    // marker names this family, the caller is its parent, and they created it.
    if (progress?.family_id !== existingMembership.family_id || existingMembership.role !== 'parent') {
      return { ok: false, error: t('onboardingWizard.contextChanged') };
    }
    {
      const { data: adoptable, error: adoptableError } = await admin
        .from('families').select('created_by').eq('id', existingMembership.family_id).maybeSingle();
      if (adoptableError) return onboardingFailure('adopted family owner check', adoptableError, t('actions.couldNotFinishSettingUp2'));
      if (adoptable?.created_by !== auth.user.id) return { ok: false, error: t('onboardingWizard.contextChanged') };
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
    // Adopting the auto-provisioned family: this is where the name and the
    // TIMEZONE the person just typed land. Matching no rows finished onboarding
    // against a family still carrying the provisioning defaults, and the timezone
    // is not cosmetic — every reminder, digest and cron slot afterwards is
    // computed in it, so the household would be woken by a morning brief at the
    // wrong hour with nothing in the wizard to re-run. Audit C1-S9-59.
    const { data: adopted, error: adoptErr } = await admin.from('families')
      .update({ name: family.name, timezone: family.timezone }).eq('id', familyId).select('id');
    if (adoptErr) return onboardingFailure('auto-provisioned family update', adoptErr, t('actions.couldNotFinishSettingUp2'));
    if (wroteNoRows(adopted)) {
      return onboardingFailure('auto-provisioned family update', new Error('no rows updated'), t('actions.couldNotFinishSettingUp2'));
    }
  } else {
    // A child login without an active membership was removed from its family;
    // it must not mint a household of its own as that household's parent.
    if (await isChildLoginAccount(admin, auth.user)) return { ok: false, error: t('onboardingWizard.contextChanged') };
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
    // SEC-018: a resumed claim is only this user's own abandoned wizard family.
    // `onboarding_claim_family` resumes from onboarding_progress.family_id, a
    // row the user can write, and the next step upserts them into the family
    // as a PARENT with the service role — so a fresh account that named
    // someone else's family there became a parent of it and could read its
    // password vault. prepareCalendarFamily has always refused this ("Family
    // owner changed"); this is the same check, in the path that lacked it, so
    // it holds the moment this code deploys rather than when 0454 is applied.
    if (!newFamily) {
      const { data: claimed, error: claimedError } = await admin
        .from('families').select('created_by').eq('id', familyId).maybeSingle();
      if (claimedError) return onboardingFailure('claimed family owner check', claimedError, t('actions.couldNotFinishSettingUp2'));
      if (claimed?.created_by !== auth.user.id) return { ok: false, error: t('onboardingWizard.contextChanged') };
    }
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

  // 2c. Ensure a trial subscription exists (provisioning normally made one;
  //     only insert when missing so we never duplicate). Fatal when it cannot
  //     be ensured — this comment used to say "Non-fatal" above a
  //     `return onboardingFailure`.
  //
  //     A refused read used to fall through to the insert as if no row
  //     existed. The unique index on family_id (0285) then refused the insert,
  //     and onboarding failed AFTER the family and membership were created —
  //     exactly as a double submit racing itself did. A unique violation here
  //     means the row this step ensures is present, so it counts as success.
  //     Deliberately NOT an upsert on family_id: 0285 skips that index where
  //     duplicate rows already exist, and ON CONFLICT (family_id) would then
  //     fail every onboarding. Audit C1-S9-75.
  const { data: existingSub, error: existingSubError } = await admin
    .from('subscriptions').select('id').eq('family_id', familyId).limit(1);
  if (existingSubError) console.error('[onboarding] subscription check failed; ensuring by insert', { familyId, error: existingSubError });
  if (existingSubError || !existingSub || existingSub.length === 0) {
    const { error: subErr } = await admin.from('subscriptions').insert({
      family_id: familyId, plan: 'free', status: 'trialing',
      current_period_end: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    if (subErr && subErr.code !== '23505') return onboardingFailure('trial subscription creation', subErr, t('actions.couldNotFinishSettingUp2'));
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
  //
  // Stable across the WHOLE wizard, not this one payload. `runKey` digests
  // everything the wizard sent, and a retry after a later step failed rarely
  // sends the same thing: a reload drops the imported events, the PIN and the
  // calendar receipt (lib/onboarding/flow.ts), and any step can be edited. Each
  // difference was a new key for every member and invite, so every child was
  // added twice and every invitee got a second invite and a second email. The
  // household key names only the account and the family it is setting up. The
  // calendar keeps `runKey`: its rows ARE the payload.
  //
  // Within the household, a member is named by the id the draft gave it when
  // it was added (lib/onboarding/draft.ts), not by its place in the list and
  // everything in it. Keyed by (index, content), removing an earlier member
  // or fixing a name or a role before the retry made every later member a
  // new row, and every later invitee a new invite. An invite is keyed by its
  // address too: a corrected address is someone else to invite. A payload
  // without ids (an older wizard), or one that sends an id twice, keeps the
  // (index, content) key.
  const householdKey = onboardingRunKey(auth.user.id, { familyId, scope: 'onboarding-household' });
  const draftIdUses = new Map<string, number>();
  for (const m of members) if (m.id) draftIdUses.set(m.id, (draftIdUses.get(m.id) ?? 0) + 1);
  const DRAFT_ID_SLOT = -1;
  const memberSlot = (index: number, m: (typeof members)[number]): [number, unknown] => (m.id && draftIdUses.get(m.id) === 1
    ? [DRAFT_ID_SLOT, m.kind === 'invite' ? { draftId: m.id, email: m.email.trim().toLowerCase() } : { draftId: m.id }]
    : [index, m]);
  const localMembers = [...members.entries()].flatMap(([index, m]) => (m.kind === 'local'
    ? [{ m, onboarding_key: onboardingItemKey(householdKey, 'member', ...memberSlot(index, m)) }]
    : []));

  // A row this step wrote may since have been given a kid login:
  // createChildLoginAction links it (user_id) to the child's PIN account. The
  // key names that row whatever the payload now says about it, and finalize
  // can be replayed (0454), so a replay that reused a member's draft id — or
  // an id-less one that still said what the row was before — with 'adult'
  // made the kid login a manager: the role every member editor refuses for
  // one (memberHasAKidLogin, the held 0512). So the rows the keys already
  // name are read first, a manager role for one with a login is refused
  // before any member is written, and a manager role is written onto an
  // existing row only while that row is still unlinked. Anything else (a
  // name, a colour, a role that is not a manager's) is reconciled as before.
  type KeyedMember = { id: string; family_id: string; user_id: string | null; role: string; display_name: string };
  const keyedMembers = new Map<string, KeyedMember>();
  if (localMembers.length > 0) {
    const { data: keyedRows, error: keyedErr } = await admin.from('family_members')
      .select('id, family_id, user_id, role, display_name, onboarding_key')
      .eq('family_id', familyId).in('onboarding_key', localMembers.map((l) => l.onboarding_key));
    if (keyedErr) return onboardingFailure('household members read', keyedErr, t('actions.couldNotFinishSettingUp2'));
    for (const row of keyedRows ?? []) if (row.onboarding_key) keyedMembers.set(row.onboarding_key, row);
  }
  for (const { m, onboarding_key } of localMembers) {
    const row = keyedMembers.get(onboarding_key);
    if (!row || !isManager(m.role)) continue;
    // A row with a login is never given a manager role here. For one without,
    // as the editors ask it: a role it already has is not a promotion.
    if (row.user_id !== null || (m.role !== row.role && await memberHasAKidLogin(admin, row))) {
      return { ok: false, error: t('familyModule.aKidLoginCannotBeAManager', { name: row.display_name }) };
    }
  }
  for (const { m, onboarding_key } of localMembers) {
    const fields = { role: m.role, display_name: m.name, color: m.color ?? null, birthday: m.birthday || null };
    const row = keyedMembers.get(onboarding_key);
    if (row && isManager(m.role)) {
      // Compare-and-set on the link the check above saw. A kid login links
      // the row before it writes its child_logins mapping, so a row linked
      // since that check matches nothing here.
      const { data: written, error: writeErr } = await admin.from('family_members').update(fields)
        .eq('id', row.id).eq('family_id', familyId).is('user_id', null)
        .select('id');
      if (writeErr) return onboardingFailure(`member "${m.name}" update`, writeErr, t('actions.couldNotFinishSettingUp2'));
      if (wroteNoRows(written)) {
        console.error('[onboarding] member changed while it was being written', { memberId: row.id });
        return { ok: false, error: t('actions.couldNotFinishSettingUp2') };
      }
      continue;
    }
    const { error: memberErr } = await admin.from('family_members').upsert({
      family_id: familyId,
      ...fields,
      onboarding_key,
    }, { onConflict: 'family_id,onboarding_key' });
    if (memberErr) return onboardingFailure(`member "${m.name}" creation`, memberErr, 'Could not add all household members.');
  }

  // 6. Create invites and send email join links. A keyed upsert returns a row
  // only when this request created it; existing rows are reused without
  // sending a duplicate email on replay.
  // Who the invite is from, for the email's subject and body.
  const inviterName = profile.firstName.trim() || DEFAULT_OWNER_DISPLAY_NAME;
  let inviteEmailsSent = 0;
  const unsentInvites: UnsentInvite[] = [];
  for (const [index, m] of members.entries()) {
    if (m.kind !== 'invite') continue;
    const { data: invite, error: inviteErr } = await admin
      .from('invites')
      .upsert({
        family_id: familyId,
        email: m.email,
        role: m.role,
        invited_by: auth.user.id,
        onboarding_key: onboardingItemKey(householdKey, 'invite', ...memberSlot(index, m)),
      }, { onConflict: 'family_id,onboarding_key', ignoreDuplicates: true })
      .select('id, token')
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
        .select('id, token, role, status')
        .eq('family_id', familyId)
        .eq('onboarding_key', onboardingItemKey(householdKey, 'invite', ...memberSlot(index, m)))
        .maybeSingle();
      if (existingInviteErr || !existingInvite) {
        return existingInviteErr
          ? onboardingFailure(`invite for ${m.email} lookup`, existingInviteErr, t('actions.couldNotCreateAllHousehold'))
          : { ok: false, error: t('actions.couldNotCreateAllHousehold') };
      }
      token = existingInvite.token;
      // Keyed by its draft id, a retry that fixed the invitee's role names the
      // invite the first run wrote, and ignoreDuplicates left it as it was: a
      // guest when the owner had made grandpa an adult. A still-pending invite
      // takes the corrected role (compare-and-set on what was read); one already
      // accepted, revoked or expired is left alone.
      if (existingInvite.status === 'pending' && existingInvite.role !== m.role) {
        const { error: roleErr } = await admin.from('invites')
          .update({ role: m.role })
          .eq('id', existingInvite.id).eq('family_id', familyId).eq('status', 'pending').eq('role', existingInvite.role)
          .select('id');
        if (roleErr) return onboardingFailure(`invite for ${m.email} role`, roleErr, t('actions.couldNotCreateAllHousehold'));
      }
    }
    if (!invite) continue;
    // Bounded per call, per user and per family (the same family bucket
    // /api/email/invite spends). The invite row above stands either way.
    // An invite not mailed here is returned, so the Done screen can say so.
    const unsent = { id: invite.id, email: m.email };
    if (inviteEmailsSent >= ONBOARDING_INVITE_EMAIL_CAP) { unsentInvites.push(unsent); continue; }
    const userLimited = await enforceRequestRateLimit(admin, `email:onboarding-invite:${auth.user.id}`, { limit: ONBOARDING_INVITE_EMAIL_CAP, windowMs: 3_600_000 });
    if (!userLimited.ok) { unsentInvites.push(unsent); continue; }
    const familyLimited = await enforceRequestRateLimit(admin, `email:invite:${familyId}`, { limit: 20, windowMs: 3_600_000 });
    if (!familyLimited.ok) { unsentInvites.push(unsent); continue; }
    inviteEmailsSent++;
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
    const sent = await sendReactEmail({
      to: m.email,
      subject: `${inviterName} invited you to join ${family.name} on Bubaly`,
      react: React.createElement(InviteEmail, {
        familyName: family.name, inviterName, token, role: m.role,
      }),
    });
    // A rejected send, or no mail provider at all, is not a sent invite either.
    if (!sent?.ok || sent.skipped) unsentInvites.push(unsent);
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
  //
  //     Through mergeNotificationPrefs, as every other writer of the blob is:
  //     a read-then-upsert of the whole blob put back whatever it read, so an
  //     App Lock, shortcut or Google sync save that landed in between was
  //     silently undone. The merge compare-and-sets on updated_at and re-runs
  //     the change on the newer row; a read it cannot make writes nothing.
  const age = normalizeAge(appearance.age);
  // Onboarding may run again after an explicit reset or a partial finish. It
  // can prepare a first PIN, but it cannot replace or disable a lock the user
  // subsequently chose. PIN material belongs only in the private server store;
  // the public preferences blob is readable and writable by the signed-in user.
  if (appearance.pin && isValidPin(appearance.pin)) {
    const currentLock = await readAppLockRecord(auth.user.id);
    if (!currentLock.ok) return onboardingFailure('onboarding App Lock read', 'private store unavailable', t('actions.couldNotFinishSettingUp2'));
    if (currentLock.record === null) {
      const seededLock = await replaceAppLockRecord(auth.user.id, null, {
        ...(await buildAppLockConfig(appearance.pin)), enabled: false,
      });
      // Another request setting up its lock wins. Never retry onto that new
      // revision: doing so would turn a genuine enabled lock into our seed.
      if (!seededLock.ok && seededLock.reason !== 'conflict') {
        return onboardingFailure('onboarding App Lock seed', 'private store unavailable', t('actions.couldNotFinishSettingUp2'));
      }
    }
  }
  const savedPrefs = await mergeNotificationPrefs(admin, auth.user.id, (prefs) => ({
    ...prefs,
    onboardingComplete: true,
    ...(age !== null ? { age } : {}),
  }));
  const prefReadError = !savedPrefs.ok && savedPrefs.reason === 'read_failed' ? savedPrefs.error ?? new Error('read_failed') : null;
  if (prefReadError) return onboardingFailure('onboarding preferences read', prefReadError, t('actions.couldNotFinishSettingUp2'));
  const prefErr = savedPrefs.ok ? null : savedPrefs.error ?? new Error(savedPrefs.reason);
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
  // The import landed (step 6a returns before here when it did not). The
  // sample calendar ('demo') is not the household's own, so it is no import.
  if ((importEvents.length > 0 && calendarImport.source !== 'demo') || connectedReceipt) {
    await recordWizardCalendarImport(admin, auth.user.id, familyId);
  }

  // 8b. Send the branded welcome email (best-effort — the template existed but
  //     was never wired to a completion path, so no one ever received it).
  //
  //     To the ACCOUNT's address only, and once. It went to `profile.email` —
  //     a value the caller types, checked for shape and nothing else — and
  //     finalize can be replayed (a client may set its own onboarding_progress
  //     back to in_progress, 0454), so every replay mailed any address Bubaly's
  //     own sender, with a caller-chosen name in the heading. The record that
  //     says it was sent is in app_metadata (WELCOME_EMAIL_SENT_KEY), not in a
  //     column the client can rewrite, nor in a limiter bucket that is pruned
  //     after a day.
  try {
    const to = auth.user.email;
    const welcomed = Boolean(auth.user.app_metadata?.[WELCOME_EMAIL_SENT_KEY]);
    const once = to && !welcomed
      ? await enforceRequestRateLimit(admin, `email:welcome:${auth.user.id}`, { limit: 1, windowMs: WELCOME_EMAIL_RACE_WINDOW_MS })
      : { ok: false as const };
    if (to && once.ok) {
      // Recorded before it is sent. A welcome whose record could not be
      // written is not sent: the record is what stops the next replay.
      const { error: recordError } = await admin.auth.admin.updateUserById(auth.user.id, {
        app_metadata: { [WELCOME_EMAIL_SENT_KEY]: new Date().toISOString() },
      });
      if (recordError) {
        console.error('[onboarding] welcome email not sent: could not record it', recordError);
      } else {
        await sendReactEmail({
          to,
          subject: 'Welcome to Bubaly 🎉',
          react: React.createElement(WelcomeEmail, { name: profile.firstName.trim() || 'there' }),
        });
      }
    }
  } catch (e) {
    console.error('[onboarding] welcome email failed', e);
  }

  try {
    const { data: prof } = await supabase
      .from('profiles').select('display_name, full_name, email, phone').eq('id', auth.user.id).maybeSingle();
    await upsertOnboardingContact(admin, {
      userId: auth.user.id,
      // The verified address first — see the note on the other call site.
      email: auth.user.email ?? prof?.email ?? profile.email ?? null,
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
      // Verified first — see the note on the other call site.
      email: auth.user.email ?? prof?.email ?? profile.email ?? null,
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
  // Family+ only, read from the same constant the Contact Center screen and the
  // inbound webhook use. A family on Free or on the Basic trial finishes
  // onboarding without an address and claims one from the Contact Center after
  // upgrading, which is where that control has always been. Provisioning is
  // gated BEFORE the webhook deliberately: gating the webhook first would strand
  // mail addressed to an address the family still holds.
  //
  // Best effort, and last, on purpose. The family already exists and setup has
  // already succeeded by this point; a contended name, an unreachable table, or
  // an unavailable subscription read must not turn a finished onboarding into a
  // retry.
  try {
    const planLevelForFamily = await resolveFamilyPlanLevel(admin, familyId);
    const channel = planLevelForFamily >= FAMILY_EMAIL_MIN_PLAN_LEVEL
      ? await getOrCreateChannelResult(admin, familyId)
      : null;
    if (channel && !channel.error) {
      const provisioned = await provisionFamilyEmailLocal(admin, familyId, family.name);
      if (!provisioned.assigned && provisioned.reason !== 'already_assigned') {
        console.warn('[onboarding] family email address not assigned', familyId, provisioned.reason);
      }
    }
  } catch (e) {
    console.error('[onboarding] family email provisioning failed', e);
  }

  return { ok: true, data: { familyId, brief: finalBrief, ...(unsentInvites.length ? { unsentInvites } : {}) } };
}
