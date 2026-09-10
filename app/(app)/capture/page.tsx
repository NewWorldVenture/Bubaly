// /capture — one line in, the right place out. Also the PWA's share target.
//
// `app/manifest.ts` declares `share_target { action: '/capture', method: 'GET',
// params: { title, text, url } }`, so anything the OS share sheet hands Bubaly
// — an email, the text of a screenshot, a link to a school page — arrives here
// as query params. Reading them on the SERVER means the shared content is in
// the first paint: a share that cold-starts the app still shows the text,
// where a client-side read would flash an empty box first.
import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { CaptureShell } from '@/components/capture/capture-shell';
import { loadCaptureShortcuts } from '@/app/(app)/capture/shortcuts-actions';
import { sharedCaptureText } from '@/lib/capture/share';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('captureShell.capture') };
}
export const dynamic = 'force-dynamic';

export default async function CapturePage({
  searchParams,
}: {
  searchParams?: Promise<{ title?: string; text?: string; url?: string }>;
}) {
  await requireUserContext();
  const shared = searchParams ? await searchParams : {};
  // Server-load the member's saved shortcut layout (Supabase) so it's right on
  // first paint and follows them across devices.
  const initialShortcuts = await loadCaptureShortcuts();
  return <CaptureShell initialShortcuts={initialShortcuts} initialText={sharedCaptureText(shared)} />;
}
