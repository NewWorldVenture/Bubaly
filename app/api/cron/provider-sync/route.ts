import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { runProviderSync } from '@/lib/sync/engine/generic';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Scheduled two-way provider sync (item #3): keeps every connected
// Google/Microsoft account in sync WITHOUT anyone pressing "Sync now" — the
// piece that turns manual sync into real background two-way sync. Oldest-synced
// accounts first, bounded batch so the run always finishes inside maxDuration.
// Accounts whose provider keys aren't configured are skipped (key-gated).
const BATCH = 25;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const { data: accounts, error } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id, provider')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  let synced = 0, skipped = 0, failed = 0;
  const details: Record<string, unknown>[] = [];

  for (const account of accounts ?? []) {
    const adapter = getAdapter(account.provider as SyncProviderEnum);
    if (!adapter || !adapter.isConfigured()) { skipped++; continue; }
    try {
      const result = await runProviderSync(admin, account, adapter);
      if (result.error) failed++; else synced++;
      details.push({ account: account.id, provider: account.provider, ...result });
      await admin.from('sync_audit_logs').insert({
        user_id: account.user_id, family_id: account.family_id,
        provider: account.provider, action: 'sync',
        detail: { ...result, scheduled: true } as unknown as Json,
      });
    } catch (e) {
      failed++;
      details.push({ account: account.id, provider: account.provider, error: e instanceof Error ? e.message : 'unknown' });
    }
  }

  return NextResponse.json({ ok: true, synced, skipped, failed, scanned: accounts?.length ?? 0, details });
}
