import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { CaptureShell } from '@/components/capture/capture-shell';
import { loadCaptureShortcuts } from '@/app/(app)/capture/shortcuts-actions';

export const metadata: Metadata = { title: 'Capture' };
export const dynamic = 'force-dynamic';

export default async function CapturePage() {
  await requireUserContext();
  // Server-load the member's saved shortcut layout (Supabase) so it's right on
  // first paint and follows them across devices.
  const initialShortcuts = await loadCaptureShortcuts();
  return <CaptureShell initialShortcuts={initialShortcuts} />;
}
