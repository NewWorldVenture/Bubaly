'use server';

import { redirect } from 'next/navigation';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { startDemoSession, endDemoSession, cleanupExpiredDemoSessions, rotateDemoPassword } from '@/lib/demo/session';
import { demoExpiry, isLikelyEmail, isDemoEmailUsedUp } from '@/lib/demo/config';
import { captureDemoLead } from '@/lib/demo/lead';

/**
 * One-click demo: refresh THE single shared "Bubaly Demo" account (reset its data
 * to a fresh, fully-seeded state), then sign the visitor straight in (the
 * cookie-bound client sets the session) and drop them on Home. No form, no input
 * — but the app opens behind a blurred email-capture gate, and the 5-minute clock
 * only starts once they submit it (see startDemoClockAction).
 */
export async function startDemoAction(): Promise<void> {
  const creds = await startDemoSession();
  if (!creds) redirect('/pricing?demo=error');

  const supabase = await createServer();
  let { error } = await supabase.auth.signInWithPassword({ email: creds.email, password: creds.password });
  if (error) {
    // A concurrent login rotated the shared password first — rotate again + retry.
    const password = await rotateDemoPassword();
    if (password) ({ error } = await supabase.auth.signInWithPassword({ email: creds.email, password }));
  }
  if (error) redirect('/pricing?demo=error');
  redirect('/home');
}

/**
 * Start the 5-minute countdown once the visitor enters their email behind the
 * blur gate. Stamps the captured address and sets `expires_at` to now + 5 min;
 * re-rendering Home then lifts the blur and shows the running timer.
 */
export async function startDemoClockAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();

  const supabase = await createServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/pricing?demo=error');

  const admin = createServiceClient();

  // Only a live demo session may start the clock. Server actions are callable by
  // ANY signed-in user — without this check a non-demo user invoking the action
  // could be signed out (blocked path below) or have an email harvested.
  let inDemo = false;
  try {
    const { data: sess } = await admin
      .from('demo_sessions').select('user_id').eq('user_id', user.id).maybeSingle();
    inDemo = !!sess;
  } catch { /* table missing pre-migration → treat as not a demo */ }
  if (!inDemo) redirect('/home');

  // The email is REQUIRED to start the clock. The form enforces this client-side
  // (`required`, `type=email`), but a crafted POST could skip it — and an empty
  // email would both dodge the capture and slip past the one-per-email gate. An
  // invalid address just re-renders the gate (the clock stays unstarted).
  if (!isLikelyEmail(email)) redirect('/home');

  // One demo per email: if this email already used a demo whose window has
  // passed, don't start another. End the just-provisioned session and route to
  // the plan-choice page instead. (Checked out-of-band so a missing table pre-
  // migration simply doesn't gate — the redirect stays OUTSIDE the try so Next's
  // redirect signal isn't swallowed.)
  let blocked = false;
  try {
    const { data: prior } = await admin
      .from('demo_email_uses').select('expires_at').eq('email', email).maybeSingle();
    blocked = isDemoEmailUsedUp(prior?.expires_at);
  } catch { /* table missing (migration not applied) → don't gate */ }
  if (blocked) {
    await supabase.auth.signOut();
    await endDemoSession(user.id).catch(() => {});
    redirect('/demo/upgrade');
  }

  const expiresAt = demoExpiry();
  await admin
    .from('demo_sessions')
    .update({ email, expires_at: expiresAt.toISOString() })
    .eq('user_id', user.id);

  // Record this email's demo allowance durably. INSERT-ONLY (ignoreDuplicates):
  // the email's allowance is fixed at its FIRST demo's window. Overwriting on
  // re-entry was an infinite-demo loophole — re-entering within your own window
  // kept pushing expires_at into the future, so the block above never fired.
  try {
    await admin.from('demo_email_uses').upsert(
      { email, expires_at: expiresAt.toISOString(), last_used_at: new Date().toISOString() },
      { onConflict: 'email', ignoreDuplicates: true },
    );
  } catch (e) { console.error('[demo] demo_email_uses upsert failed (migration 0162 applied?)', e); }

  // Feed the marketing engine: capture the email as a DURABLE crm_contacts lead
  // (the demo_sessions.email above is a single shared row the next visitor
  // overwrites) and enroll it in the "demo_started" follow-up campaign.
  // Best-effort — never block the demo on marketing.
  await captureDemoLead(admin, email);

  redirect('/home');
}

/**
 * The demo ended (5 minutes elapsed) and the visitor chose a plan from the
 * blurred pop-up. Sign out + clear the shared demo's session row (the account
 * itself is preserved and re-seeds fresh on the next login), then send them into
 * signup for the plan they picked: 'free' → the 5-day trial, else Basic / Plus.
 */
export async function choosePlanAfterDemoAction(formData: FormData): Promise<void> {
  const plan = String(formData.get('plan') ?? 'free');

  const supabase = await createServer();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  await supabase.auth.signOut();
  if (userId) await endDemoSession(userId).catch(() => {});

  // Free → the 5-day trial (signup → onboarding, no card). Paid → create the
  // account, then land on billing which AUTO-OPENS Stripe Checkout for the plan
  // they just picked (`&checkout=<plan>`), so payment is one tap, not a hunt.
  // Checkout needs a family, which requireUserContext auto-provisions, so the
  // order must be signup → billing → Stripe.
  const billing = (p: 'basic' | 'plus') =>
    `/signup?plan=${p}&redirect=${encodeURIComponent(`/dashboard/billing?view=manage&checkout=${p}`)}`;
  const href = plan === 'basic' ? billing('basic')
    : plan === 'plus' ? billing('plus')
    : '/signup';
  redirect(href);
}

/**
 * Exit a demo early: sign out (clears the cookie) and clear the shared demo's
 * session row so the next visitor starts behind a fresh email gate. The account
 * is preserved. Called by the "Exit" button on the countdown banner.
 */
export async function endDemoAction(): Promise<void> {
  const supabase = await createServer();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  await supabase.auth.signOut();
  if (userId) await endDemoSession(userId).catch(() => {});
  redirect('/pricing?demo=ended');
}
