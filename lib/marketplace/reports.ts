// Marketplace Trust & Safety — pure engine, no I/O.
//
// Reason/status vocabularies shared by the report dialog and the super-admin
// moderation queue, plus small helpers (can this member report this listing?
// roll-up counts for the queue header). Fully tested.

export type ReportReason = 'prohibited' | 'scam' | 'miscategorized' | 'offensive' | 'spam' | 'duplicate' | 'other';
export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';

export const REPORT_REASONS: { value: ReportReason; label: string; hint: string }[] = [
  { value: 'prohibited', label: 'Prohibited item', hint: 'Weapons, alcohol, recalled, or otherwise not allowed.' },
  { value: 'scam', label: 'Scam or fraud', hint: 'Fake, misleading, or a payment scam.' },
  { value: 'miscategorized', label: 'Wrong category', hint: 'Listed under the wrong type or category.' },
  { value: 'offensive', label: 'Offensive content', hint: 'Hateful, explicit, or inappropriate for families.' },
  { value: 'spam', label: 'Spam', hint: 'Repetitive, advertising, or not a real listing.' },
  { value: 'duplicate', label: 'Duplicate', hint: 'The same item is posted more than once.' },
  { value: 'other', label: 'Something else', hint: 'Tell us what’s wrong.' },
];

const REASON_LABEL = new Map(REPORT_REASONS.map((r) => [r.value, r.label]));
export function reasonLabel(reason: string): string {
  return REASON_LABEL.get(reason as ReportReason) ?? 'Reported';
}

export const STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Open',
  reviewing: 'Reviewing',
  actioned: 'Actioned',
  dismissed: 'Dismissed',
};

export function isValidReason(reason: string): reason is ReportReason {
  return REASON_LABEL.has(reason as ReportReason);
}

/** Terminal states can't be changed again by a resolve action. */
export function isResolved(status: ReportStatus): boolean {
  return status === 'actioned' || status === 'dismissed';
}

// Status filters for the super-admin moderation queue. "Needs action" groups the
// two live states (open + reviewing) a moderator still has to work.
export type ReportFilter = 'all' | 'needs_action' | 'actioned' | 'dismissed';

export function isReportFilter(v: unknown): v is ReportFilter {
  return v === 'all' || v === 'needs_action' || v === 'actioned' || v === 'dismissed';
}

/** Does a report's status belong in the given queue filter? */
export function reportMatchesFilter(status: string, filter: ReportFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'needs_action': return status === 'open' || status === 'reviewing';
    case 'actioned': return status === 'actioned';
    case 'dismissed': return status === 'dismissed';
    default: return true;
  }
}

/** A member may report any listing that isn't their own. */
export function canReport(listingOwnerMemberId: string | null, viewerMemberId: string): boolean {
  return !!viewerMemberId && listingOwnerMemberId !== viewerMemberId;
}

export interface ReportRow { status: string; reason: string }

/** Queue roll-up: open (needs action) + counts by status and by reason. */
export function summarizeReports(rows: ReportRow[]): {
  total: number; open: number; byStatus: Record<string, number>; byReason: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return {
    total: rows.length,
    open: (byStatus.open ?? 0) + (byStatus.reviewing ?? 0),
    byStatus,
    byReason,
  };
}
