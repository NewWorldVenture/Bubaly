import type { Metadata } from 'next';
import { SettingsModule } from '@/components/modules/settings-module';
import { ProfileNudge } from '@/components/marketing/profile-nudge';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6">
        <ProfileNudge />
      </div>
      <SettingsModule />
    </div>
  );
}
