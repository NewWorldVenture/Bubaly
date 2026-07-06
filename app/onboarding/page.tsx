import type { Metadata } from 'next';
import { createServer } from '@/lib/supabase/server';
import { splitFullName } from '@/lib/onboarding/profile';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

export const metadata: Metadata = { title: 'Create your profile' };

export default async function OnboardingPage() {
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

  return <OnboardingWizard initialName={initialName} initialLastName={initialLastName} />;
}
