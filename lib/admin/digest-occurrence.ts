// Which admin digest a request belongs to, and who it goes to.
//
// POLICY DECIDED by the owner on 2026-10-02 (docs/admin-digest-route-integration.md §2):
// an occurrence is the most recent scheduled slot at or before "now", and its
// window is the 24 h that end at that slot. Every tick for the same slot (a
// retry, a late GitHub dispatch, a second scheduler) names the same occurrence,
// so the engine sends each admin that slot's digest at most once. Windows abut,
// so no activity row appears in two digests (#677 C5).
import { normalizeRecipient } from '@/lib/admin/digest-delivery';

/** `30 12 * * *` in vercel.json and scripts/cron-dispatch.mjs. */
export const ADMIN_DIGEST_SCHEDULE = { hourUtc: 12, minuteUtc: 30 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdminDigestSlot = { occurrenceId: string; window: { start: string; end: string }; slot: Date };

export function adminDigestSlot(now: Date, schedule: { hourUtc: number; minuteUtc: number } = ADMIN_DIGEST_SCHEDULE): AdminDigestSlot {
  if (!Number.isFinite(now.getTime())) throw new TypeError('admin digest: now must be a valid date');
  let slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hourUtc, schedule.minuteUtc);
  if (slot > now.getTime()) slot -= DAY_MS;
  const end = new Date(slot);
  return {
    occurrenceId: `admin-digest:${end.toISOString()}`,
    window: { start: new Date(slot - DAY_MS).toISOString(), end: end.toISOString() },
    slot: end,
  };
}

/**
 * The recipient list as the engine must receive it: trimmed, lowercased, de-duplicated.
 * `readSuperAdminRecipients` lowercases but does not trim, so " a@x.test" and "a@x.test"
 * would otherwise be two recipients, or refuse the whole occurrence as duplicates.
 * Nothing is dropped here: whether an unusable address refuses the occurrence is the
 * engine's validation, and the route reports it (docs §3).
 */
export function normalizeDigestRecipients(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    const n = normalizeRecipient(a);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
