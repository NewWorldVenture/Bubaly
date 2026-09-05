import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { LanguageModule } from '@/components/modules/language-module';

export const metadata: Metadata = { title: 'Language Practice' };

export default async function LanguagePage() {
  await requireFeature('/dashboard/language');
  return <LanguageModule />;
}
