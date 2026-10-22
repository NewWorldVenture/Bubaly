// lib/marketing/push.ts — pure helpers for the Marketing Push pillar.
// Recipient selection (dedupe + suppression filtering) and campaign rollups.
// No server-only imports so it's unit-testable; the send action does the I/O.

/** Distinct opted-in user ids, excluding any whose email is suppressed. */
export function selectPushRecipients(
  deviceUserIds: Array<string | null | undefined>,
  emailByUser: Record<string, string | null | undefined>,
  suppressedEmails: Iterable<string>,
): string[] {
  const suppressed = new Set(
    [...suppressedEmails].map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const uid of deviceUserIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const email = (emailByUser[uid] ?? '').trim().toLowerCase();
    if (email && suppressed.has(email)) continue;
    out.push(uid);
  }
  return out;
}

/**
 * Marketing push is opt-in, like every marketing_* category in
 * lib/marketing/consent.ts ("never messaged without explicit consent"). Owning
 * a push device is NOT that consent: a device is registered so the FAMILY can
 * reach its members. The consent is an explicit `true` under this key in the
 * account's `user_preferences.notification_prefs`; absent, false or malformed
 * all mean no. `onboarding_progress.marketing_opt_in` is not used because it
 * defaults to true (0159), so it cannot show that anyone chose it.
 */
export const MARKETING_PUSH_CONSENT_KEY = 'marketingPush';

/** Family roles that are minors' accounts. Never a marketing audience. */
export const MARKETING_PUSH_EXCLUDED_ROLES: readonly string[] = ['child', 'teen'];

export function hasMarketingPushConsent(notificationPrefs: unknown): boolean {
  return Boolean(notificationPrefs) && typeof notificationPrefs === 'object' && !Array.isArray(notificationPrefs)
    && (notificationPrefs as Record<string, unknown>)[MARKETING_PUSH_CONSENT_KEY] === true;
}

/** Delivered percentage (sent / recipients), 0 when no recipients. */
export function deliveryRate(sent: number, recipients: number): number {
  if (!recipients || recipients <= 0) return 0;
  return Math.round((sent / recipients) * 100);
}

export function pushDeliveryPhase(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).push_delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return null;
  const fields = delivery as Record<string, unknown>;
  return fields.version === 1 && typeof fields.attemptId === 'string' && typeof fields.phase === 'string'
    ? fields.phase : null;
}

/** A failed or legacy attempt is retryable only with durable proof of no dispatch. */
export function canSendPush(status: string, metadata?: unknown): boolean {
  const phase = pushDeliveryPhase(metadata);
  return (status === 'draft' && !phase) || (status === 'failed' && phase === 'preflight_failed');
}

/** Keep active or uncertain attempt records available for outcome review. */
export function canDeletePush(status: string, metadata?: unknown): boolean {
  const phase = pushDeliveryPhase(metadata);
  return status !== 'sending' && !['preparing', 'dispatching', 'unknown'].includes(phase ?? '');
}

/**
 * How long an attempt may sit in 'sending' before an admin may resolve it.
 * The send runs inside one server action; a platform timeout or crash kills it
 * before its catch block can record anything, and nothing else ever leaves
 * 'sending'. Far longer than any request can live, so a resolution never
 * races a send that is still running (and if one did, the send's own
 * claim-guarded writes match nothing once the row has left 'sending').
 */
export const PUSH_ATTEMPT_STALE_MS = 30 * 60_000;

export type StalePushResolution = { status: 'failed'; phase: 'preflight_failed' | 'reviewed' };

/**
 * The outcome an admin may record for an attempt that can no longer finish.
 *  - 'preparing' never reached a provider (the dispatching receipt is written
 *    before the first send), so it is a preflight failure and may be retried.
 *  - 'dispatching', a legacy attempt with no receipt, and 'unknown' (written
 *    on purpose when the results could not be saved) may have reached devices:
 *    recorded as 'reviewed', never retried, but no longer stuck.
 * 'unknown' is already final, so it needs no age; the others do.
 */
export function staleSendingResolution(
  status: string, metadata: unknown, updatedAt: string | null | undefined, now = Date.now(),
): StalePushResolution | null {
  if (status !== 'sending') return null;
  const phase = pushDeliveryPhase(metadata);
  if (phase === 'unknown') return { status: 'failed', phase: 'reviewed' };
  const since = Date.parse(updatedAt ?? '');
  if (!Number.isFinite(since) || now - since < PUSH_ATTEMPT_STALE_MS) return null;
  return { status: 'failed', phase: phase === 'preparing' ? 'preflight_failed' : 'reviewed' };
}

export type PushCampaignLike = { status: string; recipients?: number; sent?: number; failed?: number; skipped?: number; metadata?: unknown };

export function needsPushReview(row: PushCampaignLike): boolean {
  const counts = pushDeliveryCounts(row.metadata);
  // An outcome an admin already resolved as unknowable has been reviewed.
  if (row.status === 'failed' && pushDeliveryPhase(row.metadata) === 'reviewed') return false;
  return (row.status === 'failed' && !canSendPush(row.status, row.metadata))
    || row.status === 'sending'
    || (row.status === 'sent' && (counts
      ? counts.failed > 0 || counts.skipped > 0 || counts.pruned > 0
      : (row.failed ?? 0) > 0 || (row.skipped ?? 0) > 0));
}

export function pushDeliveryCounts(metadata: unknown): { accepted: number; failed: number; skipped: number; withheld: number; pruned: number } | null {
  if (!pushDeliveryPhase(metadata)) return null;
  const d = (metadata as { push_delivery: Record<string, unknown> }).push_delivery;
  const values = [d.confirmedDeviceAcceptances, d.failedDeviceOperations, d.skippedDevices, d.withheldUsers, d.prunedDevices];
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return null;
  const [accepted, failed, skipped, withheld, pruned] = values as number[];
  return { accepted, failed, skipped, withheld, pruned };
}

export function summarizePush(rows: PushCampaignLike[]) {
  let totalSent = 0;
  let totalRecipients = 0;
  let sentCampaigns = 0;
  let reviewCampaigns = 0;
  for (const r of rows) {
    totalSent += r.sent ?? 0;
    totalRecipients += r.recipients ?? 0;
    if (r.status === 'sent') sentCampaigns++;
    if (needsPushReview(r)) reviewCampaigns++;
  }
  return {
    campaigns: rows.length,
    sentCampaigns,
    totalSent,
    totalRecipients,
    // sent counts provider-accepted device requests; recipients counts users.
    // A ratio between those different units is not a delivery percentage.
    reviewCampaigns,
  };
}
