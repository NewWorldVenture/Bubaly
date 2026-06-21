import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { deliverNotificationEmails } from '@/lib/server/notification-emails';

export const runtime = 'nodejs';

// Runs a few times a day via Vercel Cron. Generates "who needs to know"
// notifications for every family, then emails each member a digest of their
// pending (unsent) notifications.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: families, error } = await supabase.from('families').select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let total = 0;
  for (const f of families ?? []) {
    try {
      total += await generateFamilyNotifications(supabase, f.id);
    } catch (e) {
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
  }

  // Email digests across all families (one query set, respects the per-user
  // email toggle and marks rows sent so they aren't re-emailed).
  let emailed = 0;
  try {
    emailed = await deliverNotificationEmails(supabase);
  } catch (e) {
    console.error('Notification email delivery failed:', e);
  }

  return NextResponse.json({ families: families?.length ?? 0, created: total, emailed });
}
