import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getRefreshToken } from '@/lib/sync/accounts';
import { getAdapter } from '@/lib/sync/registry';
import type { SyncProviderEnum } from '@/lib/database.types';

// Provider-generic disconnect (R9): revokes the grant at the provider (best
// effort) and deletes the account row (cascades tokens, connections, external
// mappings). Imported calendars/events are kept.
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const ctx = await requireUserContext();
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;
  const admin = createServiceClient();

  const adapter = getAdapter(provider);
  const { data: account } = await admin
    .from('sync_accounts')
    .select('id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (account) {
    if (adapter) {
      const refresh = await getRefreshToken(admin, account.id).catch(() => null);
      if (refresh) await adapter.revokeToken(refresh).catch(() => { /* best effort */ });
    }
    await admin.from('sync_accounts').delete().eq('id', account.id);
    await admin.from('sync_audit_logs').insert({
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'disconnect',
    });
  }

  // 303 → the browser follows the POST with a GET.
  return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?disconnected=1`, req.nextUrl.origin), 303);
}
