import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { SettingsModule } from '@/components/modules/settings-module';
import { ProfileNudge } from '@/components/marketing/profile-nudge';
import { DisplayComfort } from '@/components/app/display-comfort';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getReferralConfigResult } from '@/lib/referrals/server';
import type { ReferralConfig } from '@/lib/referrals/core';
import { readOwnedProfileState } from '@/lib/marketing/profile-state-server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.settings') };
}
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // The profile nudge's state, read here so its card is in the first paint
  // rather than arriving above the page (PERF-001). Read only: null for a user
  // who owns no contact yet, and the card asks for it from the browser.
  //
  // Only the user's id is needed, read as app/(app)/layout.tsx reads it.
  // requireUserContext would add two reads to every load of this page and, for
  // a user with no family yet, provision one during a GET. A read that does
  // not answer is logged, and the card is left to the browser: it decorates
  // the page and gates nothing.
  const { data: auth, error: authError } = await (await createServer()).auth.getUser();
  if (authError && authError.name !== 'AuthSessionMissingError') console.error('[settings] signed-in user read failed', authError);
  const profileState = auth.user ? readOwnedProfileState(createServiceClient(), auth.user.id) : null;
  // The invite-success referral prompt quotes the program's real amounts. A
  // failed settings read is logged and the prompt falls back to the defaults
  // inside the module (this read decorates a promo; it gates nothing).
  let referralConfig: ReferralConfig | undefined;
  try {
    const result = await getReferralConfigResult(createServiceClient());
    if (result.error) console.error('[settings] referral config read failed', result.error);
    else referralConfig = result.config;
  } catch (err) {
    console.error('[settings] referral config read failed', err);
  }

  return (
    <div className="space-y-4">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-4 sm:px-6">
        <ProfileNudge initial={await profileState} />
        <DisplayComfort />
      </div>
      <SettingsModule referralConfig={referralConfig} />
    </div>
  );
}
