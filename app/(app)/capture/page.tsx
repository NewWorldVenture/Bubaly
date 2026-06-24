import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { CaptureShell } from '@/components/capture/capture-shell';

export const metadata: Metadata = { title: 'Capture' };

export default async function CapturePage() {
  await requireUserContext();
  return <CaptureShell />;
}
