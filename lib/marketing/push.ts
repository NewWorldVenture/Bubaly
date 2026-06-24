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

/** Only draft (or previously-failed) campaigns can be sent. */
export function canSendPush(status: string): boolean {
  return status === 'draft' || status === 'failed';
}

export type PushCampaignLike = { status: string; recipients?: number; sent?: number };

export function summarizePush(rows: PushCampaignLike[]) {
  let totalSent = 0;
  let totalRecipients = 0;
  let sentCampaigns = 0;
  for (const r of rows) {
    totalSent += r.sent ?? 0;
    totalRecipients += r.recipients ?? 0;
    if (r.status === 'sent') sentCampaigns++;
  }
  return {
    campaigns: rows.length,
    sentCampaigns,
    totalSent,
    totalRecipients,
    deliveryRate: deliveryRate(totalSent, totalRecipients),
  };
}
