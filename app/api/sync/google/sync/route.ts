import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { runGoogleSync } from '@/lib/sync/engine/google';
import type { Json } from '@/lib/database.types';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { logSyncAudit } from '@/lib/sync/audit';
import { combineRunResults } from '@/lib/sync/run-results';

// Runs a two-way Google sync for the current user's connected account.
export async function POST() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  // Every Google account this person connected, not one: sync_accounts is
  // unique on (user_id, provider, external_id), so a personal and a work
  // account are two rows, and maybeSingle failed the whole sync on the second.
  const { data: accounts, error: accountError } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', 'google')
    .eq('user_id', ctx.user.id);

  if (accountError) {
    console.error('[sync] Google account read failed', accountError);
    return NextResponse.json({ error: t('sync.syncFailed') }, { status: 503 });
  }
  if (!accounts?.length) return NextResponse.json({ error: t('sync.googleIsNotConnectedFor') }, { status: 400 });

  const limited = await enforceRequestRateLimit(admin, `sync:${ctx.active.familyId}:${ctx.user.id}:google`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('sync.tooManySyncRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const results = [];
  for (const account of accounts) {
    const result = await runGoogleSync(admin, account);
    results.push(result);
    await logSyncAudit(admin, {
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'sync',
      detail: result as unknown as Json,
    });
  }
  const result = combineRunResults(results);

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
