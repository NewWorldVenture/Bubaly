import type { Metadata } from 'next';
import { SettingsModule } from '@/components/modules/settings-module';

export const metadata: Metadata = { title: 'Family Settings' };

export default function FamilySettingsPage() {
  return <SettingsModule />;
}
