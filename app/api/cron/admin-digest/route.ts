import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAll } from '@/lib/supabase/read-all';
import { allSuperAdminEmails } from '@/lib/feedback/notify';
import { sendEmail } from '@/lib/server/email';
import {
  buildAdminDigest, digestSubject, renderAdminDigestHtml, summarizeDigestDelivery, type DigestRow,
} from '@/lib/admin/digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Daily Super Admin digest. Rolls up the last 24h of admin_notifications
// (signups, paid conversions, feedback, tickets, Trust & Safety, sync) into one
// growth-first email to every super admin. Sends ONLY on days with activity —
// no empty-run noise. CRON_SECRET-gated; dark (logs, no send) without a RESEND
// key. Scheduled in vercel.json.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('adminDigest.unauthorized') }, { status: 401 });
  }

  const admin = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // The whole 24h window, paged — not `.limit(500)`.
  //
  // Only eight rows are ever RENDERED (`recent` is sliced to 8 downstream), so
  // the read exists to compute `digest.total` and the per-kind counts — and
  // those are precisely what a cap falsifies. `total` is `rows.length`, and the
  // order is `created_at` DESC, so on a day with more than 500 notifications the
  // email reported the most recent 500 AS THE DAY'S TOTAL, dropping the earliest
  // twenty-odd hours, with nothing in the message saying so. A super admin reads
  // this for signups and paid conversions and would have acted on a number that
  // was quietly short.
  //
  // Nor is 500 an unreachable figure: `admin_notifications` carries sync errors
  // (`github_error`) alongside growth events, so the most likely way to exceed
  // it is an error storm — the exact day the digest most needs to be right.
  //
  // `readAll`'s `max` is a real ceiling: it reads one row PAST it to tell "there
  // were exactly max" from "there were more", and returns an error for the
  // second. A truncated read is a failed read, so both cases answer 502 and the
  // scheduler retries rather than delivering a confident undercount. Twenty
  // thousand admin notifications in one day is itself an incident worth a 502.
  const { rows: feed, error: feedError } = await readAll<DigestRow>((from, to) => admin
    .from('admin_notifications')
    .select('kind, title, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .order('title')
    .range(from, to), { max: 20_000 });

  if (feedError) {
    console.error('[admin-digest] notification feed read failed', feedError);
    return NextResponse.json({ ok: false, error: t('adminDigest.notificationFeedUnavailable') }, { status: 502 });
  }

  const rows = feed;
  const digest = buildAdminDigest(rows);

  // Quiet day → no email, but report the no-op honestly.
  if (digest.isEmpty) {
    return NextResponse.json({ ok: true, sent: 0, total: 0, reason: 'no activity in the last 24h' });
  }

  const emails = await allSuperAdminEmails(admin);
  if (emails.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, total: digest.total, reason: 'no super-admin recipients' });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const html = renderAdminDigestHtml(digest, { appUrl, dateLabel, recent: rows });
  const subject = digestSubject(digest, dateLabel);

  const delivery = await Promise.all(
    emails.map((to) => sendEmail({ to, subject, html }).catch(() => ({ ok: false }))),
  );
  const summary = summarizeDigestDelivery(delivery);

  return NextResponse.json({
    ...summary,
    recipients: emails.length,
    total: digest.total,
    headline: digest.headline,
  }, { status: summary.ok ? 200 : 502 });
}
