import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFamilyNotifications } from '@/lib/server/notifications';

export const runtime = 'nodejs';

// Runs a few times a day via Vercel Cron. Generates "who needs to know"
// notifications for every family from their upcoming events/chores/etc.
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

  return NextResponse.json({ families: families?.length ?? 0, created: total });
}
