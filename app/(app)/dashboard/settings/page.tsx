import type { Metadata } from 'next';
import { SettingsModule } from '@/components/modules/settings-module';
import { ProfileNudge } from '@/components/marketing/profile-nudge';
import { DisplayComfort } from '@/components/app/display-comfort';
import { createServiceClient } from '@/lib/supabase/server';
import { getReferralConfigResult } from '@/lib/referrals/server';
import type { ReferralConfig } from '@/lib/referrals/core';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
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
        <ProfileNudge />
        <DisplayComfort />
      </div>
      <SettingsModule referralConfig={referralConfig} />
    </div>
  );
}
