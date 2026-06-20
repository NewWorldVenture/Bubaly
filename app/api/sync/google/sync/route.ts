import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { runGoogleSync } from '@/lib/sync/engine/google';
import type { Json } from '@/lib/database.types';

// Runs a two-way Google sync for the current user's connected account.
export async function POST() {
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  const { data: account } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', 'google')
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (!account) return NextResponse.json({ error: 'Google is not connected for this account.' }, { status: 400 });

  const result = await runGoogleSync(admin, account);

  await admin.from('sync_audit_logs').insert({
    user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'sync',
    detail: result as unknown as Json,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
