'use server';

import { createServer, createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { sendEmail } from '@/lib/server/email';
import { APP_URL } from '@/lib/email';
import { createFamilySchema, familyDetailsSchema, finalizeOnboardingSchema, inviteSchema, onboardingProfileSchema } from '@/lib/validation';
import { saveUserProfile } from '@/lib/server/profiles';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
import { isValidPin, normalizeAge } from '@/lib/onboarding/pin';
import { buildAppLockConfig } from '@/lib/security/app-lock';
import { cleanGoals, cleanReferralSource } from '@/lib/onboarding/family';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { upsertOnboardingContact } from '@/lib/marketing/onboarding-contact';
import { parseIcs, toBriefEvents, demoBriefEvents } from '@/lib/onboarding/ics';
import { buildFirstBrief, briefSummary, type BriefEvent, type FirstBrief } from '@/lib/onboarding/first-brief';
import type { MemberRole } from '@/lib/constants/roles';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/**
 * VALUE-FIRST (T1): parse the family's existing calendar (pasted .ics or a
 * generated sample week) and compute the instant "first brief" payoff — with NO
 * database write. This is the engine behind the onboarding value step: the user
 * sees their day/week come together before we ask them to configure anything.
 * The parsed events are handed back so the wizard can carry them to finalize,
 * which persists them into the real family's calendar.
 */
export async function previewCalendarImportAction(input: {
  source: 'paste' | 'demo'; icsText?: string;
}): Promise<Result<{ brief: FirstBrief; events: BriefEvent[]; source: string }>> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const now = new Date();
  let events: BriefEvent[] = [];
  let source = input.source;

  if (input.source === 'demo') {
    events = demoBriefEvents(now);
    source = 'demo';
  } else {
    const text = (input.icsText ?? '').trim();
    if (!text) return { ok: false, error: 'Paste your calendar’s .ics text, or try the sample week.' };
    if (!text.includes('BEGIN:VEVENT')) {
      return { ok: false, error: 'That doesn’t look like a calendar (.ics) export. Try again or use the sample week.' };
    }
    events = toBriefEvents(parseIcs(text)).slice(0, 1000);
    if (events.length === 0) return { ok: false, error: 'No events found in that calendar.' };
    source = 'paste';
  }

  const brief = buildFirstBrief(events, now);
  return { ok: true, data: { brief, events, source } };
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

  // 4. Persist age + seeded App Lock + completion flag (merge — never clobber prefs).
  //    The onboarding PIN seeds the App Lock config (same salted-SHA-256 scheme the
  //    Settings card uses) but is stored DISABLED: App Lock stays off until the user
  //    flips it on in Settings — at which point they don't have to re-enter the PIN.
  //    Service-role client so it persists reliably under this env's flaky RLS writes.
  const { data: prefRow } = await admin
    .from('user_preferences').select('notification_prefs').eq('user_id', auth.user.id).maybeSingle();
  const prefs = (prefRow?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...prefs, onboardingComplete: true };
  const age = normalizeAge(input.age);
  if (age !== null) merged.age = age;
  if (input.pin && isValidPin(input.pin)) {
    merged.appLock = { ...(await buildAppLockConfig(input.pin)), enabled: false };
  }
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

  // 5. Feed the marketing engine: create/enrich the account holder's CRM contact
  //    and fire the welcome ("onboarding_completed") automation. The signed-in
  //    user is the family's parent/admin (ensureActiveFamily provisions the
  //    `parent` member), so the contact is stamped as such. Best-effort — never
  //    blocks the user finishing onboarding.
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
  appearance?: { color?: string; age?: number | null; avatarUrl?: string; pin?: string };
  calendarImport?: { source: string; events: BriefEvent[] };
}): Promise<Result<{ familyId: string }>> {
  const parsed = finalizeOnboardingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid onboarding data' };

  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  const { profile, family, details, members, appearance, calendarImport } = parsed.data;

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
    console.error('[onboarding] parent member upsert failed', ownerErr);
    return { ok: false, error: 'Could not finish setting up your space. Please try again.' };
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
    if (subErr) console.error('[onboarding] trial subscription insert failed', subErr);
  }

  // 3. Set this as the active family (service-role + logged: if this silently
  //    failed under RLS the user could land on an auto-provisioned space instead
  //    of the family they just named).
  const { error: activeErr } = await admin.from('user_preferences').upsert(
    { user_id: auth.user.id, active_family_id: familyId },
    { onConflict: 'user_id' },
  );
  if (activeErr) console.error('[onboarding] active-family save failed', activeErr);

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
  if (detailsErr) console.error('[onboarding] family details save failed', detailsErr);

  // 5. Insert local (managed) members — no user_id, no login (service-role +
  //    logged so a member the user added never silently vanishes).
  for (const m of members) {
    if (m.kind !== 'local') continue;
    const { error: memberErr } = await admin.from('family_members').insert({
      family_id: familyId,
      role: m.role,
      display_name: m.name,
      color: m.color ?? null,
      birthday: m.birthday || null,
    });
    if (memberErr) console.error(`[onboarding] member "${m.name}" insert failed`, memberErr);
  }

  // 6. Create invites and send email join links (invite row via service role +
  //    logged; the email itself is best-effort and never throws).
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? APP_URL;
  for (const m of members) {
    if (m.kind !== 'invite') continue;
    const { data: invite, error: inviteErr } = await admin
      .from('invites')
      .insert({ family_id: familyId, email: m.email, role: m.role, invited_by: auth.user.id })
      .select('token')
      .single();
    if (inviteErr || !invite) {
      console.error(`[onboarding] invite for ${m.email} failed`, inviteErr);
      continue;
    }
    const link = `${origin}/join?token=${invite.token}`;
    await sendEmail({
      to: m.email,
      subject: 'You’re invited to a family on Bubaly',
      html: `<p>You’ve been invited to join a family on Bubaly.</p><p><a href="${link}">Accept your invite</a></p>`,
    });
  }

  // 6a. VALUE-FIRST (T1): persist the calendar the user imported in the value step
  //     into the real family's calendar_events, then record the first-value moment
  //     in onboarding_imports (the seed of the TTFV metric). Both are best-effort —
  //     a hiccup here must never block the user finishing onboarding. The brief is
  //     recomputed server-side (never trust the client) for the durable summary.
  const importEvents = (calendarImport?.events ?? []).slice(0, 1000);
  if (importEvents.length > 0) {
    const eventRows = importEvents.map((e) => ({
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
    }));
    let importedCount = 0;
    for (let i = 0; i < eventRows.length; i += 200) {
      const chunk = eventRows.slice(i, i + 200);
      const { error: evErr } = await admin.from('calendar_events').insert(chunk);
      if (evErr) console.error('[onboarding] calendar import insert failed', evErr.message);
      else importedCount += chunk.length;
    }

    try {
      const brief = buildFirstBrief(importEvents, new Date());
      const { error: impErr } = await admin.from('onboarding_imports').insert({
        family_id: familyId,
        source: (calendarImport?.source as 'ics' | 'paste' | 'url' | 'demo') || 'paste',
        event_count: importedCount,
        today_count: brief.todayCount,
        conflict_count: brief.conflicts.length,
        action_count: brief.actions.length,
        time_saved_minutes: brief.timeSavedMinutes,
        brief: briefSummary(brief) as never,
        created_by: auth.user.id,
      });
      if (impErr) console.error('[onboarding] import record failed', impErr.message);
    } catch (e) {
      console.error('[onboarding] first-brief record failed', e);
    }
  }

  // 6b. Persist the account holder's age + optional App Lock PIN + the
  //     onboardingComplete flag into the core user_preferences.notification_prefs
  //     jsonb (merge — never clobber). The PIN seeds App Lock DISABLED (same
  //     salted-SHA-256 scheme as Settings); it stays off until the user enables
  //     it, at which point they don't have to re-enter the PIN. Service-role so it
  //     persists reliably under this env's flaky RLS writes.
  const { data: prefRow } = await admin
    .from('user_preferences').select('notification_prefs').eq('user_id', auth.user.id).maybeSingle();
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
  if (prefErr) console.error('[onboarding] preferences (PIN/age/flag) save failed', prefErr);

  // 7. Audit
  await logAudit(supabase, {
    familyId, actorId: auth.user.id,
    action: 'create', resource: 'families', resourceId: familyId,
    metadata: { name: family.name, members: members.length },
  });

  // 8. Feed the marketing engine (CRM contact + welcome automation) — best-effort.
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
        members_invited: members.filter((m) => m.kind === 'invite').length,
        members_added: members.filter((m) => m.kind === 'local').length,
      },
    });
    await fireAutomationEvent(admin, {
      trigger: 'onboarding_completed',
      email: prof?.email ?? profile.email ?? auth.user.email ?? null,
      name: prof?.display_name ?? prof?.full_name ?? profile.firstName ?? null,
      subjectKey: eventSubjectKey('onboarding_completed', [familyId]),
      context: { familyId, goals, referral_source: referralSource },
    });
  } catch (e) {
    console.error('[onboarding] automation event failed', e);
  }

  return { ok: true, data: { familyId } };
}
