import type { Metadata } from 'next';
import { createServer } from '@/lib/supabase/server';
import { splitFullName } from '@/lib/onboarding/profile';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

export const metadata: Metadata = { title: 'Set up your family' };

export default async function OnboardingPage() {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();

  let initial = { firstName: '', lastName: '', phone: '', email: '' };
  if (auth.user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone, email')
      .eq('id', auth.user.id)
      .maybeSingle();
    const metaName = (auth.user.user_metadata?.full_name as string | undefined) ?? null;
    const { firstName, lastName } = splitFullName(profile?.full_name ?? metaName);
    initial = {
      firstName,
      lastName,
      phone: profile?.phone ?? '',
      email: profile?.email ?? auth.user.email ?? '',
    };
  }

  return <OnboardingWizard initialProfile={initial} />;
}
