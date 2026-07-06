import type { Metadata } from 'next';
import { createServer } from '@/lib/supabase/server';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

export const metadata: Metadata = { title: 'Welcome to Bubaly' };

export default async function OnboardingPage() {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();

  // Pre-fill the FULL name from the profile row or the sign-up metadata — the
  // wizard uses the surname to suggest a family name ("The Lee Family"), so most
  // users just confirm and keep moving.
  let initialName = '';
  if (auth.user) {
    const { data: profile } = await supabase
      .from('profiles').select('display_name, full_name').eq('id', auth.user.id).maybeSingle();
    const metaName = (auth.user.user_metadata?.full_name as string | undefined) ?? null;
    initialName = (profile?.full_name ?? profile?.display_name ?? metaName ?? '').trim();
  }

  return <OnboardingWizard initialName={initialName} />;
}
