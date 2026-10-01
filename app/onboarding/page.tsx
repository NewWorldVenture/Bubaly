import type { Metadata } from 'next';
import { createServer } from '@/lib/supabase/server';
import { splitFullName } from '@/lib/onboarding/profile';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { configuredAdapters } from '@/lib/sync/registry';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getUserContext } from '@/lib/supabase/auth';
import { scopeFromUserContext } from '@/lib/services/scope';
import { verifyCalendarWizard } from '@/lib/services/onboarding-calendar/setup';
import { authScreenHref, parseReviewSelection, reviewBillingPath, reviewOnboardingPath } from '@/lib/billing/review-selection';
import { getTranslations } from '@/lib/i18n/server';
import { decodePendingChoice, LOCALE_PENDING_COOKIE } from '@/lib/i18n/pending-choice';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('onboardingWizard.createProfileTitle') };
}

export default async function OnboardingPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams ?? {};
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  const reviewPlan = parseReviewSelection(params);
  // The page owns the query-aware entry decision. Keep the existing owner and
  // pending-activation gate ahead of profile reads and provider configuration.
  const ctx = await getUserContext();
  if (!ctx) redirect(authScreenHref('/login', { next: reviewPlan ? reviewOnboardingPath(reviewPlan) : null, reviewPlan }));
  // A language chosen while signed out becomes this account's before the wizard
  // renders, so it cannot outlive the wizard as anyone's (#705 review
  // 5374948393). The claim writes a cookie, which a page render cannot: the
  // Route Handler does it and sends the person straight back here.
  if (decodePendingChoice((await cookies()).get(LOCALE_PENDING_COOKIE)?.value)?.owner === null) {
    redirect(`/onboarding/language${params.size ? `?${params}` : ''}`);
  }
  const supabase = await createServer();
  if (!('needsFamily' in ctx) && !await verifyCalendarWizard(scopeFromUserContext(ctx, supabase), { allowPendingActivation: true })) {
    redirect(reviewPlan ? reviewBillingPath(reviewPlan) : '/dashboard');
  }
  const account = z.string().uuid().safeParse(query.calendarAccount);
  const status = typeof query.calendarStatus === 'string' && ['connected', 'cancelled', 'unavailable'].includes(query.calendarStatus) ? query.calendarStatus : undefined;
  const providers = hasEncryptionKey() ? configuredAdapters().map((adapter) => adapter.provider).filter((provider): provider is 'google' | 'microsoft' => provider === 'google' || provider === 'microsoft') : [];
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user || (!('needsFamily' in ctx) && ctx.user.id !== auth.user.id)) throw new Error('Account context is temporarily unavailable.');

  // Pre-fill the name from the profile row or the sign-up metadata so the user
  // usually just taps Continue. The last name is carried through silently (the
  // wizard never asks again) so "Jordan Smoke" at signup stays "Jordan Smoke".
  let initialName = '';
  let initialLastName = '';
  if (auth.user) {
    const { data: profile } = await supabase
      .from('profiles').select('display_name, full_name').eq('id', auth.user.id).maybeSingle();
    const metaName = (auth.user.user_metadata?.full_name as string | undefined) ?? null;
    const { firstName, lastName } = splitFullName(profile?.full_name ?? profile?.display_name ?? metaName);
    initialName = firstName;
    initialLastName = lastName;
  }

  return <OnboardingWizard initialName={initialName} initialLastName={initialLastName} calendarProviders={providers}
    key={`${auth.user.id}:${'needsFamily' in ctx ? '' : ctx.active.familyId}`}
    expectedOwner={{ userId: auth.user.id, familyId: 'needsFamily' in ctx ? null : ctx.active.familyId }} reviewPlan={reviewPlan}
    calendarAccountId={account.success ? account.data : undefined} calendarStatus={status} />;
}
