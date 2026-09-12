import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { sendPushToUser, pushConfigured } from '@/lib/server/push';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sends a test push to the signed-in user's OWN registered devices. Lets a user
 * confirm end-to-end push delivery on their phone without waiting for the
 * notification engine. Honest: reports counts and whether push is configured.
 */
export async function POST() {
  const t = await getTranslations();
  const user = await getUser();
  if (!user) return NextResponse.json({ error: t('test.unauthorized') }, { status: 401 });

  const cfg = pushConfigured();
  if (!cfg.web && !cfg.native) {
    return NextResponse.json(
      { ok: false, error: t('test.pushIsnTConfiguredOn'), configured: cfg },
      { status: 503 },
    );
  }

  // Service client so dispatch can read this user's device rows + prune stale ones.
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `push:test:${user.id}`, { limit: 5 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('test.tooManyTestPushesPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }
  const result = await sendPushToUser(supabase, user.id, {
    title: 'Bubaly test 🔔',
    body: 'If you can read this, push notifications are working on this device.',
    url: '/dashboard/notifications',
  });

  const ok = result.sent > 0 && result.failed === 0 && result.skipped === 0;
  return NextResponse.json(
    { ok, result, configured: cfg },
    { status: ok ? 200 : result.failed > 0 ? 502 : result.skipped > 0 ? 503 : 409 },
  );
}
