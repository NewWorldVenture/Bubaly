import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredDemoSessions } from '@/lib/demo/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Reaps expired one-click demo sessions (family + auth user) — the backstop for
// visitors who close the tab without exiting. The timer + Exit button handle the
// common cases; this catches the rest. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const reaped = await cleanupExpiredDemoSessions();
    return NextResponse.json({ ok: true, reaped });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
