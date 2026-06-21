import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { sendPushToUser, pushConfigured } from '@/lib/server/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sends a test push to the signed-in user's OWN registered devices. Lets a user
 * confirm end-to-end push delivery on their phone without waiting for the
 * notification engine. Honest: reports counts and whether push is configured.
 */
export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = pushConfigured();
  if (!cfg.web && !cfg.native) {
    return NextResponse.json(
      { ok: false, error: 'Push isn’t configured on the server yet (no VAPID/FCM keys).', configured: cfg },
      { status: 503 },
    );
  }

  // Service client so dispatch can read this user's device rows + prune stale ones.
  const supabase = createServiceClient();
  const result = await sendPushToUser(supabase, user.id, {
    title: 'FamilyOS test 🔔',
    body: 'If you can read this, push notifications are working on this device.',
    url: '/dashboard/notifications',
  });

  return NextResponse.json({ ok: true, result, configured: cfg });
}
