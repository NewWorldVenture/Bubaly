import type { Metadata } from 'next';
import { Bell, TrendingUp } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import type { AdminNotificationRow } from '@/lib/admin/notifications';
import { buildAdminDigest } from '@/lib/admin/digest';
import { AdminNotificationsList, NOTIFICATION_KIND_ORDER } from '@/components/admin/admin-notifications-list';
import { ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Notifications', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** The newest notifications the list holds. */
const LISTED = 300;
/** Notifications the last-24-hours rollup may page through before it says it is not shown. */
const DIGEST_ROW_CEILING = 25_000;

// The full Super Admin Notification Center history. Super-admin gating happens
// in app/(app)/admin/layout.tsx; here we just read the whole admin_notifications
// feed with the service role (the table has no client policy).
export default async function AdminNotificationsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // The "N unread" line, the All chip and each kind's chip were tallied from
  // the newest 300 the list holds, and the last-24-hours rollup was taken from
  // the same 300, so past them each was a count of the list presented as the
  // feed's (coverage sweep round 9, class B). They are head:true counts of the
  // whole feed now, the rollup reads every notification of the last 24 hours
  // (paged on the id to a ceiling past which it says it is not shown), and the
  // list says when it holds only part of the feed. Any of these reads that
  // fails is the read-error state.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const counted = () => supabase.from('admin_notifications').select('id', { count: 'exact', head: true });
  // Started before the list is awaited, so they cost no extra round trip; each
  // settles, so a list read that fails below leaves nothing unhandled.
  const totalsRead = Promise.all([
    settleAll([
      counted(),
      counted().eq('is_read', false),
      readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('admin_notifications').select('id, kind, title, created_at').gte('created_at', dayAgo);
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: DIGEST_ROW_CEILING }),
    ]),
    settleAll(NOTIFICATION_KIND_ORDER.map((kind) => counted().eq('kind', kind))),
  ]);
  const { data, error } = await supabase
    .from('admin_notifications')
    .select('id, kind, title, body, url, is_read, created_at')
    .order('created_at', { ascending: false })
    .limit(LISTED);
  if (error) {
    console.error('[admin-notifications] notification read failed', error);
    return <AdminNotificationsReadError />;
  }
  const [[totalResult, unreadResult, dayResult], kindResults] = await totalsRead;
  const digestCeiling = 'truncated' in dayResult && dayResult.truncated;
  const totalsError = totalResult.error ?? unreadResult.error ?? (digestCeiling ? null : dayResult.error)
    ?? kindResults.find((r) => r.error)?.error;
  if (totalsError) {
    console.error('[admin-notifications] notification read failed', totalsError);
    return <AdminNotificationsReadError />;
  }

  const notifications = (data ?? []) as AdminNotificationRow[];
  const unread = unreadResult.count ?? 0;
  const totals = {
    all: totalResult.count ?? 0,
    unread,
    byKind: Object.fromEntries(NOTIFICATION_KIND_ORDER.map((kind, i) => [kind, kindResults[i]?.count ?? 0])),
  };

  // Same growth-first rollup the daily digest email sends, computed live over the
  // last 24h so the super admin gets it in-app too (reuses the tested pure lib).
  const digest = digestCeiling ? null : buildAdminDigest(dayResult.data ?? []);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Bell className="h-6 w-6 text-brand-text" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminNotifications.notifications')}</h1>
          <p className="mt-1 text-sm text-muted">
            Every super-admin alert in one place — new feedback &amp; bugs, GitHub sync relays, support
            tickets, Trust &amp; Safety reports, new family signups, and paid conversions.
            {unread > 0 ? ` ${unread} unread.` : ' All caught up.'}
          </p>
        </div>
      </div>

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: DIGEST_ROW_CEILING.toLocaleString() })}
        failures={digestCeiling ? [t('adminNotifications.last24Hours')] : []}
      />

      {digest && !digest.isEmpty && (
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
              <TrendingUp className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('adminNotifications.last24Hours')}</p>
              <p className="text-sm font-semibold text-fg">{digest.headline}</p>
            </div>
          </div>
          {digest.byKind.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {digest.byKind.map((k) => (
                <span key={k.kind} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
                  <span className="font-semibold text-fg">{k.count}</span>
                  <span className="text-muted">{k.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <AdminNotificationsList notifications={notifications} totals={totals} />
    </div>
  );
}

async function AdminNotificationsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('notifications.notifications')}</h1>
        <p className="mt-1 text-sm text-muted">{t('notifications.everySuperAdminAlertIn')}</p>
      </div>
      <ErrorState message={t('notifications.couldNotLoadAdminNotifications')} />
      <a href="/admin/notifications" className="text-sm font-medium text-brand-text underline">{t('notifications.refreshNotifications')}</a>
    </div>
  );
}
