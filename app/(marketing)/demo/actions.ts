'use server';

import { redirect } from 'next/navigation';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { startDemoSession, endDemoSession, cleanupExpiredDemoSessions, rotateDemoPassword } from '@/lib/demo/session';
import { demoExpiry } from '@/lib/demo/config';
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
  await admin
    .from('demo_sessions')
    .update({ email: email || null, expires_at: demoExpiry().toISOString() })
    .eq('user_id', user.id);

  // Feed the marketing engine: capture the email as a DURABLE crm_contacts lead
  // (the demo_sessions.email above is a single shared row the next visitor
  // overwrites) and enroll it in the "demo_started" follow-up campaign.
  // Best-effort — never block the demo on marketing.
  if (email) await captureDemoLead(admin, email);

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

  const href = plan === 'basic' ? '/signup?plan=basic'
    : plan === 'plus' ? '/signup?plan=plus'
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
