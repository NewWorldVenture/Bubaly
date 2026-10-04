// /api/cron/admin-digest on the per-recipient delivery engine. OFF unless
// ADMIN_DIGEST_DELIVERY_ENGINE=1; with the flag unset the route keeps its current
// behaviour. Turning it on also needs migrations 0471 and 0474 applied and verified
// in that environment. See docs/admin-digest-route-integration.md for the gates and the
// owner's decisions.
import { randomUUID } from 'node:crypto';
import {
  deliverDigestOccurrence, recipientKeyOf, type DeliveryStatus, type DigestDeliveryStore, type DigestEmailProvider,
  type EngineConfig, type EngineDeps, type OccurrenceReport, RESEND_KEY_RETENTION_MS,
} from '@/lib/admin/digest-delivery';
import { createPostgresDigestDeliveryStore, supabaseRpc } from '@/lib/admin/digest-delivery-store';
import { adminDigestSlot, normalizeDigestRecipients } from '@/lib/admin/digest-occurrence';
import { createResendDigestProvider } from '@/lib/admin/digest-provider';
import { buildAdminDigest, digestSubject, renderAdminDigestHtml, type DigestRow } from '@/lib/admin/digest';
import { superAdminEmails } from '@/lib/constants/super-admins';
import { FROM_EMAIL } from '@/lib/email';
import { readSuperAdminRecipients } from '@/lib/feedback/notify';
import { createServiceClient } from '@/lib/supabase/server';

export const adminDigestEngineEnabled = () => process.env.ADMIN_DIGEST_DELIVERY_ENGINE === '1';

/** Values approved by the owner on 2026-10-02 (docs §4). validateConfig refuses anything unsafe. */
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

const COUNTED: readonly DeliveryStatus[] = ['accepted', 'withdrawn', 'pending', 'in_flight', 'failed', 'unknown', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation'];

/**
 * The application's half of eligibility at each send's admission (0474): the code/config allowlist,
 * read again at every admission, so a SUPER_ADMIN_EMAILS change is seen by the next send. The store
 * adds super_admins, read after its row lock. A recipient in neither is withdrawn, not sent.
 */
export const allowlistEligibility: EngineDeps['eligibility'] = {
  allowlisted: (recipientKey) => superAdminEmails().some((e) => recipientKeyOf(e) === recipientKey),
};

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

const FEED_PAGE = 1000;
const FEED_MAX = 20_000;
type FeedRow = DigestRow & { id: string };

/**
 * The slot's window, read so that no row is counted twice. It reads the window of the slot, not "the
 * last 24 h", so every tick for one slot reads the same rows, and windows abut.
 *
 * OFFSET paging is not enough before a plan is frozen. A row that becomes visible between two pages
 * and sorts ahead of the boundary shifts every later offset, so a row already read is read again,
 * and the frozen digest would carry an invented count. This traversal is keyset: newest first by
 * (created_at, id), and each page starts strictly after the last row read. It also de-duplicates by
 * id.
 *
 * Late-arrival policy: a row that becomes visible mid-read is counted only if it sorts after the
 * cursor. Otherwise it is left for a retry, which reports planMismatch.payloadChanged. Either way,
 * every counted row exists and is counted once. The bound is the current route's: more than 20,000
 * rows is a failed read.
 */
async function readWindowFeed(admin: Admin, window: { start: string; end: string }): Promise<{ rows: DigestRow[]; error: unknown | null }> {
  const rows: DigestRow[] = [];
  const seen = new Set<string>();
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    let q = admin.from('admin_notifications').select('id, kind, title, created_at')
      .gte('created_at', window.start).lt('created_at', window.end);
    if (cursor) q = q.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    let data: FeedRow[] | null;
    let error: unknown;
    try {
      ({ data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(FEED_PAGE) as { data: FeedRow[] | null; error: unknown });
    } catch (cause) {
      return { rows, error: cause };
    }
    if (error) return { rows, error };
    if (!Array.isArray(data)) return { rows, error: new Error('The data page was unavailable') };
    // A short page may be PostgREST's response cap; only an empty page proves the end.
    if (data.length === 0) return { rows, error: null };
    if (data.some((r) => !r || typeof r.id !== 'string' || !r.id
      || typeof r.created_at !== 'string' || !r.created_at
      || typeof r.kind !== 'string' || typeof r.title !== 'string')) {
      return { rows, error: new Error('The data page was malformed') };
    }
    const last = data[data.length - 1];
    if (cursor && !(last.created_at < cursor.createdAt
      || (last.created_at === cursor.createdAt && last.id < cursor.id))) {
      return { rows, error: new Error('The data page did not advance the cursor') };
    }
    const before = rows.length;
    for (const r of data) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push({ kind: r.kind, title: r.title, created_at: r.created_at });
    }
    if (rows.length > FEED_MAX) return { rows, error: new Error(`more than ${FEED_MAX} notifications in one window`) };
    if (rows.length === before) return { rows, error: new Error('The data page repeated previously read rows') };
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

export async function runAdminDigestEngine(deps: AdminDigestEngineDeps): Promise<AdminDigestEngineResult> {
  const { occurrenceId, window, slot } = adminDigestSlot(deps.now());

  const { rows, error: feedError } = await readWindowFeed(deps.admin, window);
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
      eligibility: allowlistEligibility,
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

/** The route's wiring: the 0471 + 0474 store over the service client, and the Resend adapter. */
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
