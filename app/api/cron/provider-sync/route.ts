import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { runLeasedProviderSync } from '@/lib/sync/account-lease';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Scheduled two-way provider sync (item #3): keeps every connected
// Google/Microsoft account in sync WITHOUT anyone pressing "Sync now" — the
// piece that turns manual sync into real background two-way sync. A bounded
// batch so the run always finishes inside maxDuration, taken in turn (below).
// Accounts whose provider keys aren't configured are skipped (key-gated).
const BATCH = 25;

// The batch used to be the 25 accounts with the oldest `last_synced_at`, and
// only a SUCCESS advances that column. An account refused or failing every
// time (a revoked grant, an unconfigured provider, a policy refusal) kept its
// place at the head for ever, so 25 of them anywhere in the product took every
// run and no healthy family was synced in the background again. The run now
// walks enabled accounts in id order from a cursor kept in app_settings (as
// push dispatch does), wrapping at the end: every account gets its turn
// whatever the last outcome. Two overlapping runs can still share a batch.
const CURSOR_KEY = 'provider_sync_cursor:v1';
// A run stops taking new accounts once this much of maxDuration is spent, so
// it ends on its own and records where it got to; the next run goes on from
// there. One provider call can still outlast the rest of maxDuration: the
// cursor already names that account, so the next run starts after it.
const RUN_BUDGET_MS = 240_000;

function cursorAfter(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('providerSync.unauthorized') }, { status: 401 });
  }

  const admin = createServiceClient();
  const { data: stored, error: cursorReadError } = await admin
    .from('app_settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (cursorReadError) {
    // Without the cursor this run would start over at the same batch.
    console.error('Provider-sync cursor read failed:', cursorReadError);
    return NextResponse.json({ ok: false, error: t('providerSync.providerSynchronizationFailed') }, { status: 500 });
  }
  const after = cursorAfter(stored?.value);
  // Only accounts of OPEN families. A closed family (families.closed_at) keeps
  // its stored provider tokens so it can reopen, but nothing uses them while it
  // is closed. Filtered in the query, not after it, so a closed family's
  // accounts never take a place in the batch.
  const enabled = (size: number) => admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id, provider, family:families!inner(closed_at)')
    .is('family.closed_at', null)
    .in('sync_direction', ['import', 'export', 'two_way'])
    .order('id', { ascending: true })
    .limit(size);
  let { data: accounts, error } = await (after ? enabled(BATCH).gt('id', after) : enabled(BATCH));
  if (!error && after && (accounts?.length ?? 0) < BATCH) {
    // A short page is the end of the list only when nothing follows its last
    // row. PostgREST's db-max-rows hands back fewer rows than asked for without
    // saying so, and wrapping on such a page skipped every account past it.
    const lastRead = accounts?.[accounts.length - 1]?.id;
    const following = lastRead ? await enabled(1).gt('id', lastRead) : null;
    if (following?.error) error = following.error;
    else if (!following?.data?.length) {
      // End of the list: wrap round to the start, up to where this pass began.
      const wrapped = await enabled(BATCH - (accounts?.length ?? 0)).lte('id', after);
      if (wrapped.error) error = wrapped.error;
      else accounts = [...(accounts ?? []), ...(wrapped.data ?? [])];
    }
  }
  if (error) {
    console.error('Provider-sync cron read failed:', error);
    return NextResponse.json({ ok: false, error: t('providerSync.providerSynchronizationFailed') }, { status: 500 });
  }

  let synced = 0, skipped = 0, failed = 0, auditFailed = 0, attempted = 0;
  // An account another sync holds — a member pressed "Sync now" as this run
  // reached it, or the two schedulers' runs share this batch — is neither
  // synced nor failed: that sync is applying a snapshot at least as fresh as
  // this one would (lib/sync/engine/generic.ts claimAccountLease). Counted
  // apart, so a busy account does not turn the run red.
  let busy = 0;
  const details: Record<string, unknown>[] = [];

  // The cursor names the last account this run took its turn at. It moves
  // just before each account is tried, so a run that dies on one (a provider
  // call that never returns) leaves the next run starting after it, not back
  // at the head of a batch it never got through.
  let cursorAt = after;
  let reached: string | null = null;
  const moveCursorTo = async (id: string) => {
    if (id === cursorAt) return true;
    const { data: saved, error: cursorWriteError } = await admin.from('app_settings')
      .upsert({ key: CURSOR_KEY, value: { id }, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('key').maybeSingle();
    // Read back, as push dispatch's cursor is: a write that names no row is
    // unconfirmed, and the run does not go on as though the cursor moved.
    if (cursorWriteError || saved?.key !== CURSOR_KEY) {
      console.error('Provider-sync cursor write failed:', cursorWriteError ?? { key: CURSOR_KEY, error: 'no row written' });
      return false;
    }
    cursorAt = id;
    return true;
  };
  // Without the cursor the next run would repeat this one: stop here.
  const cursorRefused = () => NextResponse.json(
    { ok: false, error: t('providerSync.providerSynchronizationFailed'), synced, skipped, busy, failed, auditFailed, scanned: accounts?.length ?? 0, details },
    { status: 500 },
  );

  for (const account of accounts ?? []) {
    const adapter = getAdapter(account.provider as SyncProviderEnum);
    if (!adapter || !adapter.isConfigured()) { skipped++; reached = account.id; continue; }
    // At least one account per run, so every run makes progress.
    if (attempted > 0 && Date.now() - startedAt >= RUN_BUDGET_MS) break;
    if (!(await moveCursorTo(account.id))) return cursorRefused();
    reached = account.id;
    attempted++;
    try {
      // A connection whose owner has been removed from the family is switched
      // OFF rather than synced. Removal is a soft `is_active = false` that
      // leaves sync_accounts in place, and this job runs on the service role,
      // so it kept pulling the removed member's calendar into the household and
      // pushing the household's events out to them — with nobody left able to
      // disconnect it (the owner has no family; managers are not the owner).
      // loadSyncExecutionPolicy (inside runProviderSync) refuses such an
      // account too; disabling it here also takes it out of the rotation.
      const { data: owner, error: ownerError } = await admin.from('family_members').select('id')
        .eq('family_id', account.family_id).eq('user_id', account.user_id).eq('is_active', true).limit(1);
      if (ownerError) throw ownerError;
      if (!owner?.length) {
        // The account row was just read, so zero rows is a failure; an account
        // may have no connection rows, so zero there is ordinary.
        const [{ data: accountOff, error: accountOffError }, { error: connectionOffError }] = await Promise.all([
          admin.from('sync_accounts').update({ sync_direction: 'disabled' }).eq('id', account.id).eq('family_id', account.family_id).select('id'),
          admin.from('sync_connections').update({ sync_direction: 'disabled' }).eq('account_id', account.id).eq('family_id', account.family_id).select('id'),
        ]);
        if (accountOffError || connectionOffError) throw accountOffError ?? connectionOffError;
        if (!accountOff?.length) throw new Error('Removed member sync account could not be disabled');
        skipped++;
        details.push({ account: account.id, provider: account.provider, disabled: 'ownerRemoved' });
        continue;
      }
      // Under the account's lease (lib/sync/account-lease.ts): one sync of an
      // account at a time, whichever caller asks.
      const result = await runLeasedProviderSync(admin, account, adapter);
      if (result.busy) {
        busy++;
        details.push({ account: account.id, provider: account.provider, busy: true });
        continue;
      }
      if (result.error) failed++; else synced++;
      details.push({
        account: account.id,
        provider: account.provider,
        imported: result.imported,
        exported: result.exported,
        skipped: result.skipped,
        conflicts: result.conflicts,
        ...(result.error ? { error: t('providerSync.providerSynchronizationFailed') } : {}),
      });
      const { error: auditError } = await admin.from('sync_audit_logs').insert({
        user_id: account.user_id, family_id: account.family_id,
        provider: account.provider, action: 'sync',
        detail: { ...result, scheduled: true } as unknown as Json,
      });
      if (auditError) {
        auditFailed++;
        console.error(`Provider sync audit log failed for account ${account.id}:`, auditError);
      }
    } catch (e) {
      failed++;
      console.error(`Provider sync failed for account ${account.id}:`, e);
      details.push({ account: account.id, provider: account.provider, error: t('providerSync.providerSynchronizationFailed') });
    }
  }

  // Where this run got to, past any accounts it skipped after the last one tried.
  if (reached && !(await moveCursorTo(reached))) return cursorRefused();

  const ok = failed === 0 && auditFailed === 0;
  return NextResponse.json(
    { ok, synced, skipped, busy, failed, auditFailed, scanned: accounts?.length ?? 0, details },
    { status: ok ? 200 : 502 },
  );
}
