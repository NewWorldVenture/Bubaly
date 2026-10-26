// The withdrawal path for the Intelligence Network: leaving, or switching off a
// scope that contributes.
//
// intelligence-module wrote both from the browser, so nothing ordered them
// against the nightly aggregation. A run that had read consent before a leave
// stored the family's row again after the module deleted it, and counted it in
// a new publication after the family had been told it had left. The writes are
// the same and go through the member's own client (RLS: managers only, 0353);
// what this adds is the publication claim around them
// (lib/network/withdrawal-server.ts). Joining, widening, and switching off a
// scope no metric belongs to stay in the module: none of them can put a
// withdrawn family into the figures.
'use server';

import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { CONSENT_SCOPES, type ConsentScope } from '@/lib/network/insights';
import { withdrawFromNetwork, type NetworkWithdrawal } from '@/lib/network/withdrawal-server';
import type { Tables } from '@/lib/database.types';

type Consent = Tables<'network_consent'>;

export type NetworkWithdrawalResult =
  /** `fenced`: no publication written after this answer includes the withdrawal (withdrawal-server.ts). */
  | { ok: true; rows: Consent[]; fenced: boolean }
  /** `rows`: the consent that WAS written, for the screen, when only the forget failed. */
  | { ok: false; error: string; rows?: Consent[] };

/** Only the three known scopes, each a boolean, or nothing at all. */
function scopesFrom(input: unknown): Partial<Record<ConsentScope, boolean>> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Partial<Record<ConsentScope, boolean>> = {};
  for (const { key } of CONSENT_SCOPES) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return null;
    out[key] = value;
  }
  return out;
}

export async function withdrawFromNetworkAction(
  change: { leave: true } | { scopes: Record<string, unknown> },
): Promise<NetworkWithdrawalResult> {
  const t = await getTranslations();
  // Outside the try: `requireUserContext` redirects a signed-out caller by throwing.
  const ctx = await requireUserContext();
  const notSaved = t('errors.thatChangeWasNotSaved');
  // Consent is the household managers' decision. RLS refuses anyone else's
  // write since 0353; refused here too, so it is said rather than filtered.
  if (!isManager(ctx.active.role)) return { ok: false, error: notSaved };
  // A browser can call this with anything, so the change is read, not trusted.
  if (!change || typeof change !== 'object') return { ok: false, error: notSaved };
  let withdrawal: NetworkWithdrawal;
  if ('leave' in change && change.leave === true) withdrawal = { leave: true };
  else {
    const scopes = 'scopes' in change ? scopesFrom(change.scopes) : null;
    if (!scopes) return { ok: false, error: notSaved };
    withdrawal = { scopes };
  }

  try {
    const user = await createServer();
    let service: ReturnType<typeof createServiceClient> | null = null;
    try {
      service = createServiceClient();
    } catch (err) {
      // No claim, and the withdrawal is still written: it is never dropped.
      console.error('[intelligence-action] no service client for the publication claim', err);
    }
    const outcome = await withdrawFromNetwork(user, service, { familyId: ctx.active.familyId, userId: ctx.user.id }, withdrawal);
    switch (outcome.status) {
      case 'withdrawn': return { ok: true, rows: outcome.rows, fenced: outcome.fenced };
      case 'not_saved': return { ok: false, error: notSaved };
      case 'consent_failed': return { ok: false, error: describeActionError(outcome.error, notSaved) };
      case 'forget_failed': return { ok: false, error: describeActionError(outcome.error, notSaved), rows: outcome.rows };
    }
  } catch (err) {
    console.error('[intelligence-action] withdrawal failed', err);
    return { ok: false, error: describeActionError(err, notSaved) };
  }
}
