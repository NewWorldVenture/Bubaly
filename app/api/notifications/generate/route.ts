import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { generateFamilyNotifications } from '@/lib/server/notifications';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const created = await generateFamilyNotifications(supabase, ctx.active.familyId);
    return NextResponse.json({ created });
  } catch (err) {
    console.error('Notification generate error:', err);
    return NextResponse.json({ error: 'Could not refresh notifications.' }, { status: 500 });
  }
}
