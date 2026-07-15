import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { allSuperAdminEmails } from '@/lib/feedback/notify';
import { sendEmail } from '@/lib/server/email';
import {
  buildAdminDigest, digestSubject, renderAdminDigestHtml, type DigestRow,
} from '@/lib/admin/digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Daily Super Admin digest. Rolls up the last 24h of admin_notifications
// (signups, paid conversions, feedback, tickets, Trust & Safety, sync) into one
// growth-first email to every super admin. Sends ONLY on days with activity —
// no empty-run noise. CRON_SECRET-gated; dark (logs, no send) without a RESEND
// key. Scheduled in vercel.json.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = await admin
    .from('admin_notifications')
    .select('kind, title, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);

  const rows = (data ?? []) as DigestRow[];
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

  const results = await Promise.all(
    emails.map((to) => sendEmail({ to, subject, html }).then((r) => r.ok).catch(() => false)),
  );
  const sent = results.filter(Boolean).length;

  return NextResponse.json({ ok: true, sent, recipients: emails.length, total: digest.total, headline: digest.headline });
}
