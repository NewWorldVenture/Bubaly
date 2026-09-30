// /api/cron/admin-digest on the per-recipient delivery engine. OFF unless
// ADMIN_DIGEST_DELIVERY_ENGINE=1; with the flag unset the route keeps its current
// behaviour. Turning it on also needs migration 0471 applied and verified in that
// environment. See docs/admin-digest-route-integration.md for the gates and the
// decisions that are still open.
import { randomUUID } from 'node:crypto';
import {
  deliverDigestOccurrence, type DeliveryStatus, type DigestDeliveryStore, type DigestEmailProvider,
  type EngineConfig, type OccurrenceReport, RESEND_KEY_RETENTION_MS,
} from '@/lib/admin/digest-delivery';
import { createPostgresDigestDeliveryStore, supabaseRpc } from '@/lib/admin/digest-delivery-store';
import { adminDigestSlot, normalizeDigestRecipients } from '@/lib/admin/digest-occurrence';
import { createResendDigestProvider } from '@/lib/admin/digest-provider';
import { buildAdminDigest, digestSubject, renderAdminDigestHtml, type DigestRow } from '@/lib/admin/digest';
import { FROM_EMAIL } from '@/lib/email';
import { readSuperAdminRecipients } from '@/lib/feedback/notify';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';

export const adminDigestEngineEnabled = () => process.env.ADMIN_DIGEST_DELIVERY_ENGINE === '1';

/** PROPOSED values (docs §4). validateConfig refuses anything unsafe. */
export const ADMIN_DIGEST_ENGINE_CONFIG: EngineConfig = {
  leaseMs: 5 * 60 * 1000,
  sendTimeoutMs: 15 * 1000,
  maxAttempts: 5,
  providerKeyRetentionMs: RESEND_KEY_RETENTION_MS,
  retentionSafetyMarginMs: 60 * 60 * 1000,
};

type Admin = ReturnType<typeof createServiceClient>;

export type AdminDigestEngineDeps = {
  admin: Admin;
  store: DigestDeliveryStore;
  provider: DigestEmailProvider;
  owner: string;
  now: () => Date;
  config?: EngineConfig;
  appUrl?: string;
  from?: string;
};

export type AdminDigestEngineResult = { status: number; body: Record<string, unknown> };

const COUNTED: readonly DeliveryStatus[] = ['accepted', 'pending', 'in_flight', 'failed', 'unknown', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation'];

/** The response carries counts and the occurrence id only: no address, key or message body. */
function summarize(report: OccurrenceReport) {
  const statuses = Object.values(report.statuses ?? {});
  return {
    occurrenceId: report.occurrenceId,
    created: report.created,
    complete: report.complete,
    statuses: report.statuses === null ? null : Object.fromEntries(COUNTED.map((s) => [s, statuses.filter((x) => x === s).length]).filter(([, n]) => n)),
    attempts: report.attempts.length,
    sentThisRun: report.attempts.filter((a) => a.result === 'accepted').length,
    refused: report.refused.length,
    storageErrors: report.storageErrors.length,
    needsAttention: report.needsAttention.length,
    planMismatch: report.planMismatch,
  };
}

export async function runAdminDigestEngine(deps: AdminDigestEngineDeps): Promise<AdminDigestEngineResult> {
  const { occurrenceId, window, slot } = adminDigestSlot(deps.now());

  // The slot's own window, not "the last 24 h": every tick for this slot reads the same rows, and
  // windows abut, so no activity row is in two digests. Paged and bounded as the current route is.
  const { rows, error: feedError } = await readAll<DigestRow>((from, to) => deps.admin
    .from('admin_notifications')
    .select('kind, title, created_at')
    .gte('created_at', window.start)
    .lt('created_at', window.end)
    .order('created_at', { ascending: false })
    .order('title')
    .order('id')
    .range(from, to), { max: 20_000 });
  if (feedError) {
    console.error('[admin-digest] notification feed read failed', feedError);
    return { status: 502, body: { ok: false, occurrenceId, reason: 'notification_feed_unavailable' } };
  }
  const digest = buildAdminDigest(rows);
  if (digest.isEmpty) return { status: 200, body: { ok: true, occurrenceId, sent: 0, total: 0, reason: 'no activity in the window' } };

  const recipients = await readSuperAdminRecipients(deps.admin);
  if (recipients.failure !== null) {
    console.error('[admin-digest] super-admin recipient read failed', recipients.failure, recipients.cause);
    return { status: 502, body: { ok: false, occurrenceId, reason: 'recipients_unavailable' } };
  }
  const emails = normalizeDigestRecipients(recipients.emails);
  if (emails.length === 0) return { status: 200, body: { ok: true, occurrenceId, sent: 0, total: digest.total, reason: 'no super-admin recipients' } };

  const appUrl = (deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.bubaly.com').replace(/\/$/, '');
  // Labelled by the slot, not by the clock, so a retry renders the same bytes.
  const dateLabel = slot.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const payload = {
    from: deps.from ?? FROM_EMAIL,
    subject: digestSubject(digest, dateLabel),
    html: renderAdminDigestHtml(digest, { appUrl, dateLabel, recent: rows }),
  };

  let report: OccurrenceReport;
  try {
    report = await deliverDigestOccurrence({ occurrenceId, window, recipients: emails, payload }, {
      store: deps.store, provider: deps.provider, owner: deps.owner, now: deps.now, config: deps.config ?? ADMIN_DIGEST_ENGINE_CONFIG,
    });
  } catch (err) {
    // validatePlan / validateConfig: refused before anything is stored or sent. The message names
    // the rule, never an address.
    if (err instanceof TypeError) {
      return { status: 502, body: { ok: false, occurrenceId, reason: 'plan_refused', detail: err.message } };
    }
    throw err;
  }
  // Not complete → non-2xx, so a scheduler retry resumes THIS occurrence. That is safe: a retry
  // reuses the stored plan, keys and bytes, and parked rows are never sent again.
  return {
    status: report.complete ? 200 : 502,
    body: { ok: report.complete, ...summarize(report), recipients: emails.length, total: digest.total, headline: digest.headline },
  };
}

/** The route's wiring: the 0471 store over the service client, and the Resend adapter. */
export async function runAdminDigestEngineForRoute(admin: Admin): Promise<AdminDigestEngineResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    // Nothing could be sent, so nothing is frozen: a plan stored now would only collect refusals.
    return { status: 503, body: { ok: false, reason: 'email_provider_not_configured' } };
  }
  return runAdminDigestEngine({
    admin,
    store: createPostgresDigestDeliveryStore(supabaseRpc(admin)),
    provider: createResendDigestProvider({ apiKey }),
    owner: `admin-digest-route:${randomUUID()}`,
    now: () => new Date(),
  });
}
