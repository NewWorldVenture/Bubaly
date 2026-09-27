import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { VoiceModule } from '@/components/modules/voice-module';

export const metadata: Metadata = { title: 'Voice Control' };

export default async function VoicePage() {
  await requireUserContext();
  return <VoiceModule />;
}
