import type { Metadata } from 'next';
import { createServer } from '@/lib/supabase/server';
import { splitFullName } from '@/lib/onboarding/profile';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { configuredAdapters } from '@/lib/sync/registry';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { z } from 'zod';

export const metadata: Metadata = { title: 'Create your profile' };

export default async function OnboardingPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams ?? {};
  const account = z.string().uuid().safeParse(query.calendarAccount);
  const status = typeof query.calendarStatus === 'string' && ['connected', 'cancelled', 'unavailable'].includes(query.calendarStatus) ? query.calendarStatus : undefined;
  const providers = hasEncryptionKey() ? configuredAdapters().map((adapter) => adapter.provider).filter((provider): provider is 'google' | 'microsoft' => provider === 'google' || provider === 'microsoft') : [];
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();

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
    calendarAccountId={account.success ? account.data : undefined} calendarStatus={status} />;
}
