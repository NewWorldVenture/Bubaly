// Pure helpers for the Super Admin Notification Center (the admin bell).
// Deterministic, tested (tests/admin-notifications.test.ts) — no Supabase/React.

export type AdminNoteKind =
  | 'feedback_new' | 'github_sync' | 'github_error'
  | 'support_ticket' | 'marketplace_report' | 'info';

export type AdminNotificationRow = {
  id: string; kind: string; title: string; body: string | null;
  url: string | null; is_read: boolean; created_at: string;
};

/** Label + colour tone per kind (icon is chosen in the client component). */
export const ADMIN_NOTE_KIND_META: Record<AdminNoteKind, { label: string; tone: string }> = {
  feedback_new:       { label: 'Feedback',       tone: 'text-amber-500' },
  github_sync:        { label: 'GitHub sync',    tone: 'text-brand-text' },
  github_error:       { label: 'GitHub error',   tone: 'text-rose-500' },
  support_ticket:     { label: 'Support ticket', tone: 'text-blue-500' },
  marketplace_report: { label: 'Trust & Safety', tone: 'text-rose-500' },
  info:               { label: 'Update',         tone: 'text-muted' },
};

export function isAdminNoteKind(v: unknown): v is AdminNoteKind {
  return typeof v === 'string' && v in ADMIN_NOTE_KIND_META;
}

export function adminNoteKindMeta(kind: string): { label: string; tone: string } {
  return isAdminNoteKind(kind) ? ADMIN_NOTE_KIND_META[kind] : ADMIN_NOTE_KIND_META.info;
}

/** Count of unread notifications. */
export function unreadCount(rows: readonly { is_read: boolean }[]): number {
  return rows.reduce((n, r) => n + (r.is_read ? 0 : 1), 0);
}

/** Badge text for a count: '', '1'..'9', then '9+'. */
export function badgeText(n: number): string {
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}
