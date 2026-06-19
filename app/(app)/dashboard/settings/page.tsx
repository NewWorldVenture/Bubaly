import type { Metadata } from 'next';
import { SettingsModule } from '@/components/modules/settings-module';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return <SettingsModule />;
}
