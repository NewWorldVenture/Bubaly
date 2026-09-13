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

export type PushCampaignLike = { status: string; recipients?: number; sent?: number; failed?: number; skipped?: number; metadata?: unknown };

export function needsPushReview(row: PushCampaignLike): boolean {
  const counts = pushDeliveryCounts(row.metadata);
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
