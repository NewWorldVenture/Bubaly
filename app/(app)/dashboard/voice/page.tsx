import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { VoiceModule } from '@/components/modules/voice-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.voiceControl') };
}

export default async function VoicePage() {
  await requireUserContext();
  return <VoiceModule />;
}
