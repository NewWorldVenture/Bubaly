import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { runProviderSync } from '@/lib/sync/engine/generic';
import type { Json, SyncProviderEnum } from '@/lib/database.types';

// Provider-agnostic two-way sync (R9). Runs a sync for the current user's connected
// account of ANY registered provider by resolving the adapter from the registry and
// driving the generic engine. New providers plug in with no route changes.
export async function POST(req: Request) {
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  const body = await req.json().catch(() => ({}));
  const provider = body?.provider as SyncProviderEnum | undefined;
  if (!provider) return NextResponse.json({ error: 'Missing provider.' }, { status: 400 });

  const adapter = getAdapter(provider);
  if (!adapter) return NextResponse.json({ error: `No sync adapter for "${provider}".` }, { status: 400 });
  if (!adapter.isConfigured()) {
    return NextResponse.json({ error: `${adapter.label} sync isn’t configured yet.` }, { status: 503 });
  }

  const { data: account } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (!account) return NextResponse.json({ error: `${adapter.label} is not connected for this account.` }, { status: 400 });

  const result = await runProviderSync(admin, account, adapter);

  await admin.from('sync_audit_logs').insert({
    user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'sync',
    detail: result as unknown as Json,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
