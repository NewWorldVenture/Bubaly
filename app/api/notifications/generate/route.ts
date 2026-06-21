import { NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const created = await generateFamilyNotifications(supabase, ctx.active.familyId);
    // Push delivery needs cross-user device reads → service client, family-scoped.
    try {
      await dispatchPendingPushes(createServiceClient(), { familyId: ctx.active.familyId });
    } catch (e) {
      console.error('Push dispatch failed:', e);
    }
    return NextResponse.json({ created });
  } catch (err) {
    console.error('Notification generate error:', err);
    return NextResponse.json({ error: 'Could not refresh notifications.' }, { status: 500 });
  }
}
