'use server';

import { redirect } from 'next/navigation';
import { createServer } from '@/lib/supabase/server';
import { startDemoSession, endDemoSession, cleanupExpiredDemoSessions } from '@/lib/demo/session';

/**
 * One-click demo: provision a fresh Family+ demo, then sign the visitor straight
 * in (the cookie-bound client sets the session) and drop them on Home. No form,
 * no input. Also reaps any expired demos first, so abandoned tabs never pile up.
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
 * Exit a demo: sign out (clears the cookie) and fully delete the demo (family +
 * auth user), so it resets for the next visitor. Called by the countdown timer at
 * zero and by the "Exit demo" button.
 */
export async function endDemoAction(): Promise<void> {
  const supabase = await createServer();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  await supabase.auth.signOut();
  if (userId) await endDemoSession(userId).catch(() => {});
  redirect('/pricing?demo=ended');
}
