import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { runGoogleSync } from '@/lib/sync/engine/google';
import type { Json } from '@/lib/database.types';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

// Runs a two-way Google sync for the current user's connected account.
export async function POST() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  const { data: account, error: accountError } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', 'google')
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (accountError) {
    console.error('[sync] Google account read failed', accountError);
    return NextResponse.json({ error: t('sync.syncFailed') }, { status: 503 });
  }
  if (!account) return NextResponse.json({ error: t('sync.googleIsNotConnectedFor') }, { status: 400 });

  const limited = await enforceRequestRateLimit(admin, `sync:${ctx.active.familyId}:${ctx.user.id}:google`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('sync.tooManySyncRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const result = await runGoogleSync(admin, account);

  await admin.from('sync_audit_logs').insert({
    user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'sync',
    detail: result as unknown as Json,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
