'use server';

import { redirect } from 'next/navigation';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { startDemoSession, endDemoSession, cleanupExpiredDemoSessions } from '@/lib/demo/session';
import { demoExpiry } from '@/lib/demo/config';

/**
 * One-click demo: provision a fresh Family+ demo, then sign the visitor straight
 * in (the cookie-bound client sets the session) and drop them on Home. No form,
 * no input — but the app opens behind a blurred email-capture gate, and the
 * 5-minute clock only starts once they submit it (see startDemoClockAction).
 * Also reaps any expired demos first, so abandoned tabs never pile up.
 */
export async function startDemoAction(): Promise<void> {
  await cleanupExpiredDemoSessions().catch(() => {});

  const creds = await startDemoSession();
  if (!creds) redirect('/pricing?demo=error');

  const supabase = await createServer();
  const { error } = await supabase.auth.signInWithPassword({ email: creds.email, password: creds.password });
  if (error) {
    // Sign-in failed — don't leave the provisioned demo dangling.
    await endDemoSession(creds.userId).catch(() => {});
    redirect('/pricing?demo=error');
  }
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

  redirect('/home');
}

/**
 * The demo ended (5 minutes elapsed) and the visitor chose a plan from the
 * blurred pop-up. Tear the demo down (sign out + delete the family/auth user so
 * it resets for the next person), then send them into signup for the plan they
 * picked: 'free' → the 5-day trial, else Family Basic / Family+.
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
 * Exit a demo early: sign out (clears the cookie) and fully delete the demo
 * (family + auth user), so it resets for the next visitor. Called by the "Exit"
 * button on the countdown banner. `endDemoAction` redirects to /pricing.
 */
export async function endDemoAction(): Promise<void> {
  const supabase = await createServer();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  await supabase.auth.signOut();
  if (userId) await endDemoSession(userId).catch(() => {});
  redirect('/pricing?demo=ended');
}
