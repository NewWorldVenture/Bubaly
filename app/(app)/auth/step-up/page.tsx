import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { redirect } from 'next/navigation';
import { getUser, requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { readAssurance } from '@/lib/auth/require-aal2';
import { isSafeReturnPath, sessionStrength } from '@/lib/auth/mfa';
import { Logo } from '@/components/brand/logo';
import { StepUpForm } from '@/components/auth/step-up-form';

// The tab title is copy like any other: it was English in every locale.
// Audit C1-S9-100.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.confirmItsYou'), robots: { index: false, follow: false } };
}
export const dynamic = 'force-dynamic';

/**
 * Where an `aal1` session lands when a money/documents/trust page needs
 * `aal2`. Sits under `(app)` for the App Lock gate but outside `/dashboard`,
 * so it renders without the sidebar — a person mid-step-up should not be
 * offered forty other places to go.
 *
 * A session that no longer needs a code (already `aal2`, or no factor at all)
 * is sent straight back: the page never asks for something it cannot use.
 */
export default async function StepUpPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = isSafeReturnPath(rawNext) ? rawNext : '/dashboard';
  // The admin console must never require a family (app/(app)/admin/layout.tsx).
  // requireUserContext auto-provisions one for a signed-in user without one,
  // so a step-up on the way INTO /admin asks only for the signed-in user.
  const userId = isAdminConsolePath(next) ? await signedInUserId(next) : (await requireUserContext()).user.id;

  const supabase = await createServer();
  const read = await readAssurance(supabase);
  if (read.ok && sessionStrength(read.assurance) !== 'needs_step_up') redirect(next);
  if (!read.ok) console.error('[auth/step-up] assurance level read failed', { userId, error: read.error });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center px-5 py-5 pt-[calc(1.25rem+var(--safe-top))] sm:px-8">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-5 py-8">
        <div className="w-full max-w-md">
          <StepUpForm next={next} serverReadFailed={!read.ok} />
        </div>
      </main>
    </div>
  );
}

function isAdminConsolePath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/admin?') || path.startsWith('/admin#');
}

async function signedInUserId(next: string): Promise<string> {
  const user = await getUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(next)}`);
  return user.id;
}
