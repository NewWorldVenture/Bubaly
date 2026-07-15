// Pure helpers for the daily Super Admin digest email — a once-a-day rollup of
// the admin_notifications feed so the founder gets an overnight business summary
// even without opening the console. Deterministic + tested (no Supabase/React).

import { adminNoteKindMeta, countByKind } from './notifications';

export type DigestRow = { kind: string; title: string; created_at: string };

export type DigestKindLine = { kind: string; label: string; count: number };

export type AdminDigest = {
  total: number;
  isEmpty: boolean;
  byKind: DigestKindLine[];
  /** A one-line human summary leading with growth (signups / conversions). */
  headline: string;
};

// Growth-first ordering: the numbers a founder cares about most come first.
const KIND_ORDER = [
  'subscription', 'family_signup', 'feedback_new', 'support_ticket',
  'marketplace_report', 'github_error', 'github_sync', 'info',
];

function orderKinds(counts: Record<string, number>): string[] {
  const known = KIND_ORDER.filter((k) => counts[k]);
  const extra = Object.keys(counts).filter((k) => !KIND_ORDER.includes(k)).sort();
  return [...known, ...extra];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Build the digest model from the last window's admin_notifications rows. */
export function buildAdminDigest(rows: readonly DigestRow[]): AdminDigest {
  const total = rows.length;
  const counts = countByKind(rows);
  const byKind: DigestKindLine[] = orderKinds(counts).map((kind) => ({
    kind, label: adminNoteKindMeta(kind).label, count: counts[kind],
  }));
  return { total, isEmpty: total === 0, byKind, headline: buildHeadline(counts) };
}

/** Lead with the money/growth phrases; fall back to a neutral activity line. */
export function buildHeadline(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.subscription) parts.push(plural(counts.subscription, 'new paid plan'));
  if (counts.family_signup) parts.push(plural(counts.family_signup, 'new family', 'new families'));
  if (counts.feedback_new) parts.push(plural(counts.feedback_new, 'feedback item'));
  if (counts.support_ticket) parts.push(plural(counts.support_ticket, 'support ticket'));
  if (counts.marketplace_report) parts.push(plural(counts.marketplace_report, 'safety report'));
  if (counts.github_error) parts.push(plural(counts.github_error, 'sync error'));

  if (parts.length === 0) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return total === 0 ? 'A quiet day — nothing needs your attention.' : `${plural(total, 'update')} to review.`;
  }
  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

/** Subject line for the digest email. */
export function digestSubject(digest: AdminDigest, dateLabel: string): string {
  return `[Bubaly] Daily digest · ${dateLabel} — ${digest.headline}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render the digest as a self-contained HTML email body. */
export function renderAdminDigestHtml(
  digest: AdminDigest,
  opts: { appUrl: string; dateLabel: string; recent?: readonly DigestRow[] },
): string {
  const url = `${opts.appUrl.replace(/\/$/, '')}/admin/notifications`;
  const rows = digest.byKind
    .map((k) => `
      <tr>
        <td style="padding:8px 0;color:#111;font-weight:600">${escapeHtml(k.label)}</td>
        <td style="padding:8px 0;text-align:right;color:#7c5dff;font-weight:700;font-size:18px">${k.count}</td>
      </tr>`)
    .join('');

  const recentList = (opts.recent ?? []).slice(0, 8)
    .map((r) => `<li style="margin:4px 0;color:#444;line-height:1.5">${escapeHtml(adminNoteKindMeta(r.kind).label)} — ${escapeHtml(r.title)}</li>`)
    .join('');

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto">
      <p style="color:#888;font-size:13px;margin:0 0 4px">Bubaly · Super Admin</p>
      <h1 style="margin:0 0 4px;font-size:22px;color:#111">Daily digest — ${escapeHtml(opts.dateLabel)}</h1>
      <p style="margin:0 0 20px;color:#444;font-size:15px;line-height:1.5">${escapeHtml(digest.headline)}</p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;border-bottom:1px solid #eee">
        ${rows}
      </table>
      ${recentList ? `<p style="margin:20px 0 6px;color:#111;font-weight:600;font-size:14px">Highlights</p><ul style="margin:0;padding-left:18px">${recentList}</ul>` : ''}
      <p style="margin-top:24px"><a href="${url}" style="background:#7c5dff;color:#fff;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Open the Notification Center</a></p>
      <p style="margin-top:16px;color:#aaa;font-size:12px">You’re receiving this because you’re a Bubaly super admin. It only sends on days with activity.</p>
    </div>`;
}
