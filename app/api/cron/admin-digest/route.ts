import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAll } from '@/lib/supabase/read-all';
import { readSuperAdminRecipients } from '@/lib/feedback/notify';
import { sendEmail } from '@/lib/server/email';
import {
  buildAdminDigest, digestSubject, renderAdminDigestHtml, summarizeDigestDelivery, type DigestRow,
} from '@/lib/admin/digest';
import { adminDigestEngineEnabled, runAdminDigestEngineForRoute } from '@/lib/admin/digest-engine-route';
import { adminDigestSlot } from '@/lib/admin/digest-occurrence';

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

  // The per-recipient delivery engine (one digest per admin per scheduled slot) is OFF unless
  // ADMIN_DIGEST_DELIVERY_ENGINE=1, and needs migrations 0471 and 0474. docs/admin-digest-route-integration.md.
  if (adminDigestEngineEnabled()) {
    const { status, body } = await runAdminDigestEngineForRoute(admin);
    return NextResponse.json(body, { status });
  }

  // The occurrence this tick belongs to — the owner's decided policy
  // (docs/admin-digest-route-integration.md §2): the most recent 12:30 UTC slot
  // at or before now, and the 24 h that END at it. Every tick for one slot —
  // Vercel's and the GitHub dispatcher's at the same minute, a dispatch hours
  // late, the retry a 502 invites — reads the same window, renders the same
  // bytes and sends each admin under the same key, so the provider folds the
  // repeat: that is the dedupe for a mirrored tick. Two ticks whose sends
  // OVERLAP are the provider's 409 `concurrent_idempotent_requests` for the
  // second; `sendEmail` waits for the first to settle and asks again under the
  // same key, so the second is folded if the first was accepted and sent if
  // the first failed — the recipient gets this occurrence's digest on this
  // tick either way, not on a later one.
  //
  // What is and is not durable here. Resend honours a key for 24 h while the
  // payload is identical; an occurrence is live for at most 24 h (every tick
  // until the next 12:30 slot belongs to it), so no tick of one occurrence can
  // find its key expired. That is a fold at the provider, not a record of what
  // was sent: this path writes no per-recipient receipt, a retry after a 502
  // re-attempts every admin and relies on the fold for those already sent, and
  // a provider that lost its key store would send again. The delivery engine
  // above is the durable record — one receipt per admin per occurrence, and a
  // retry that attempts only the unaccepted — behind its flag, because it needs
  // migrations 0471/0474; this path needs none. Before this, the window was
  // `now - 24h` and the label the clock's date, so two ticks a minute apart
  // rendered different bytes and every super admin got two digests a day.
  const slot = adminDigestSlot(new Date());
  const since = slot.window.start;
  const until = slot.window.end;
  const keyFor = (to: string) => `admin-digest/${createHash('sha256').update(`${slot.occurrenceId}|${to}`).digest('hex')}`;

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
  //
  // (created_at, title) is not unique — two notifications of one kind in the
  // same instant tie — so `.range()` could move a page boundary inside the tie
  // and drop a row. `id` makes the order total.
  const { rows: feed, error: feedError } = await readAll<DigestRow>((from, to) => admin
    .from('admin_notifications')
    .select('kind, title, created_at')
    .gte('created_at', since)
    .lt('created_at', until)
    .order('created_at', { ascending: false })
    .order('title')
    .order('id')
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

  // Fail CLOSED on the recipient list. Sending to the env allowlist alone after a
  // failed super_admins read silently drops every admin who exists only in the
  // table, and used to answer 200 ok while doing it. An empty table is fine: the
  // allowlist is then the whole list.
  const recipients = await readSuperAdminRecipients(admin);
  if (recipients.failure !== null) {
    console.error('[admin-digest] super-admin recipient read failed', recipients.failure, recipients.cause);
    return NextResponse.json({ ok: false, error: t('adminDigest.recipientsUnavailable') }, { status: 502 });
  }
  const emails = recipients.emails;
  if (emails.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, total: digest.total, reason: 'no super-admin recipients' });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
  // Labelled by the SLOT's date, in the zone the slot is defined in, so every tick renders the same bytes.
  const dateLabel = slot.slot.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const html = renderAdminDigestHtml(digest, { appUrl, dateLabel, recent: rows });
  const subject = digestSubject(digest, dateLabel);

  const delivery = await Promise.all(
    emails.map((to) => sendEmail({ to, subject, html, idempotencyKey: keyFor(to) }).catch(() => ({ ok: false }))),
  );
  const summary = summarizeDigestDelivery(delivery);

  return NextResponse.json({
    ...summary,
    recipients: emails.length,
    total: digest.total,
    headline: digest.headline,
    occurrence: slot.occurrenceId,
  }, { status: summary.ok ? 200 : 502 });
}
