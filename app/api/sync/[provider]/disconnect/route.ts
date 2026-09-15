import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getRefreshToken } from '@/lib/sync/accounts';
import { getAdapter } from '@/lib/sync/registry';
import type { SyncProviderEnum } from '@/lib/database.types';
import { logSyncAudit } from '@/lib/sync/audit';

// Provider-generic disconnect (R9): revokes the grant at the provider (best
// effort) and deletes the account row (cascades tokens, connections, external
// mappings). Imported calendars/events are kept.
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const ctx = await requireUserContext();
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;
  const admin = createServiceClient();

  const adapter = getAdapter(provider);
  // EVERY matching account, not one. `sync_accounts` is unique on
  // (user_id, provider, external_id), so one person connecting a personal and a
  // work account of the same provider is two rows, which the connect flow
  // creates on purpose. `.maybeSingle()` rejects above one row and this error
  // was discarded, so `account` came back null, the block below was skipped
  // whole, and the redirect still reported a disconnect. A fifth way to reach
  // the sentence the comment below exists to prevent — and the only one that
  // skips the delete as well as the revoke.
  const { data: accounts, error: readError } = await admin
    .from('sync_accounts')
    .select('id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .eq('user_id', ctx.user.id);

  if (readError) {
    console.error('[sync] disconnect could not read the account rows', readError);
    return NextResponse.redirect(
      new URL(`/dashboard/sync/accounts/${raw}?error=disconnect_failed`, req.nextUrl.origin), 303);
  }

  // Revocation is best effort by design, and that is fine — what is not fine is
  // saying it happened when it did not. There are three ways to reach the end of
  // this block having revoked nothing: no adapter for the provider, no refresh
  // token to present, or revokeToken throwing into a swallowing catch. All three
  // used to land on the same "Account disconnected and access revoked." Deleting
  // our row does not withdraw a grant the provider is still holding, so a member
  // who wanted the grant gone is the one person who must not be told it is.
  // Revocation is best effort; saying it happened is not. Seeded from the
  // COUNT, not from `true`: with no rows nothing was revoked, and an empty
  // disconnect must not graduate to "access revoked" — that is the same
  // overclaim in a new place. Every account that cannot present a token, or
  // whose revoke call fails, clears it.
  let allRevoked = (accounts?.length ?? 0) > 0;
  for (const account of accounts ?? []) {
    if (adapter) {
      const refresh = await getRefreshToken(admin, account.id).catch(() => null);
      if (refresh) {
        const ok = await adapter.revokeToken(refresh).then(() => true).catch(() => false);
        if (!ok) allRevoked = false;
      } else {
        allRevoked = false;
      }
    } else {
      allRevoked = false;
    }
    // This delete IS the disconnect — the row is what keeps the account
    // connected and what every sync reads. Its result was discarded, and the
    // redirect below is unconditional, so a refused delete sent the member to a
    // page that says "Account disconnected and access revoked." while the
    // account was still connected and would sync again on the next run. Of
    // everything in this route it is the one write whose failure may not be
    // reported as success: the member's next move after being told access was
    // revoked is to stop thinking about it.
    const { error: deleteError } = await admin.from('sync_accounts').delete().eq('id', account.id);
    if (deleteError) {
      console.error('[sync] disconnect could not delete the account row', deleteError);
      return NextResponse.redirect(
        new URL(`/dashboard/sync/accounts/${raw}?error=disconnect_failed`, req.nextUrl.origin), 303);
    }
    // The account is gone by here, so a missing history row is a gap in the
    // record rather than a false claim. Reported, not fatal.
    await logSyncAudit(admin, {
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'disconnect',
    });
  }

  // 303 → the browser follows the POST with a GET.
  const outcome = allRevoked ? 'disconnected=1' : 'disconnected=kept';
  return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?${outcome}`, req.nextUrl.origin), 303);
}
