import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { cleanupExpiredDemoSessions } from '@/lib/demo/session';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Reaps expired one-click demo sessions (family + auth user) — the backstop for
// visitors who close the tab without exiting. The timer + Exit button handle the
// common cases; this catches the rest. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('demoCleanup.unauthorized') }, { status: 401 });
  }
  try {
    const reaped = await cleanupExpiredDemoSessions();
    return NextResponse.json({ ok: true, reaped });
  } catch (e) {
    console.error('Demo cleanup cron failed:', e);
    return NextResponse.json({ ok: false, error: t('demoCleanup.demoCleanupFailed') }, { status: 500 });
  }
}
