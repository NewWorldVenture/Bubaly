import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getRefreshToken } from '@/lib/sync/accounts';
import { revokeToken } from '@/lib/sync/providers/google';
import { logSyncAudit } from '@/lib/sync/audit';

// Revokes the Google grant and removes the connected account (cascades tokens,
// connections, and external mappings). Imported calendars/events are kept.
export async function POST(req: NextRequest) {
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  // EVERY matching account, not one. `sync_accounts` is unique on
  // (user_id, provider, external_id), so one person connecting a personal and a
  // work Google account is two rows — which the connect flow creates on purpose.
  // `.maybeSingle()` rejects above one row, and the error was discarded, so
  // `account` came back null, the whole block below was skipped, and this route
  // still redirected to "Account disconnected and access revoked." Nothing was
  // revoked and nothing was deleted. Of every sentence in this product that is
  // the one that must not be said falsely: the member's next move after reading
  // it is to stop thinking about the grant.
  const { data: accounts, error: readError } = await admin
    .from('sync_accounts')
    .select('id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', 'google')
    .eq('user_id', ctx.user.id);

  if (readError) {
    console.error('[sync] google disconnect could not read the account rows', readError);
    return NextResponse.redirect(
      new URL('/dashboard/sync/accounts/google?error=disconnect_failed', req.nextUrl.origin), 303);
  }

  // Revocation is best effort; saying it happened is not. Seeded from the
  // COUNT, not from `true`: with no rows nothing was revoked, and an empty
  // disconnect must not graduate to "access revoked" — that is the same
  // overclaim in a new place. Every account that cannot present a token, or
  // whose revoke call fails, clears it.
  let allRevoked = (accounts?.length ?? 0) > 0;
  for (const account of accounts ?? []) {
    const refresh = await getRefreshToken(admin, account.id).catch(() => null);
    if (refresh) {
      const ok = await revokeToken(refresh).then(() => true).catch(() => false);
      if (!ok) allRevoked = false;
    } else {
      allRevoked = false;
    }
    // This delete IS the disconnect — the row is what keeps the account
    // connected and what every sync reads.
    const { error: deleteError } = await admin.from('sync_accounts').delete().eq('id', account.id);
    if (deleteError) {
      console.error('[sync] google disconnect could not delete the account row', deleteError);
      return NextResponse.redirect(
        new URL('/dashboard/sync/accounts/google?error=disconnect_failed', req.nextUrl.origin), 303);
    }
    await logSyncAudit(admin, {
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'disconnect',
    });
  }

  // Same vocabulary as the provider-generic route, for the same reason: a grant
  // the provider still holds is not a revoked one, and the member who asked to
  // disconnect is the one person who must be told.
  const outcome = allRevoked ? 'disconnected=1' : 'disconnected=kept';
  return NextResponse.redirect(
    new URL(`/dashboard/sync/accounts/google?${outcome}`, req.nextUrl.origin), 303);
}
