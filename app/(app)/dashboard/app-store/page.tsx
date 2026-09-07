import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles, Star, BadgeCheck, Search } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { InstallButton } from '@/components/appstore/install-button';
import {
  APP_CATEGORIES, categoryLabel, filterApps, rankApps, recommendedApps, type CatalogApp,
} from '@/lib/appstore/catalog';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'App Store · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function AppStorePage({ searchParams }: { searchParams: Promise<{ cat?: string; q?: string }> }) {
  const t = await getTranslations();
  const { cat = 'all', q = '' } = await searchParams;
  const ctx = await requireUserContext();
  const sb = await createServer();

  const [{ data: apps }, { data: installs }] = await Promise.all([
    sb.from('family_apps').select('id, slug, name, tagline, category, emoji, publisher, capabilities, is_official, rating, install_count, status')
      .neq('status', 'retired').order('sort_order', { ascending: true }).limit(1000),
    sb.from('family_app_installs').select('app_id').eq('family_id', ctx.active.familyId),
  ]);

  const catalog = (apps ?? []) as CatalogApp[];
  const installedIds = new Set((installs ?? []).map((i) => i.app_id));
  const engaged = Array.from(new Set(catalog.filter((a) => installedIds.has(a.id)).map((a) => a.category)));

  const visible = rankApps(filterApps(catalog, { category: cat, q }));
  const recommended = recommendedApps(catalog, { engagedCategories: engaged, installedIds, limit: 6 });
  const installedApps = catalog.filter((a) => installedIds.has(a.id));

  const chip = (key: string, label: string) => (
    <Link key={key} href={`/dashboard/app-store?cat=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
      className={cn('whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition',
        cat === key ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:text-fg')}>
      {label}
    </Link>
  );

  return (
    <div>
      <PageHeader title={t('dashboardAppStore.familyAppStore')} description="One-tap AI extensions that plug into your family workflows. Install what helps; remove anytime." />

      {/* Search */}
      <form action="/dashboard/app-store" className="mb-4 flex items-center gap-2">
        {cat !== 'all' && <input type="hidden" name="cat" value={cat} />}
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input name="q" defaultValue={q} placeholder={t('dashboardAppStore.searchAppsCapabilities')} inputMode="search"
            className="w-full rounded-xl border border-border bg-surface/60 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-brand" />
        </div>
      </form>

      {/* Category chips (horizontal scroll on mobile) */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {chip('all', 'All')}
        {APP_CATEGORIES.map((c) => chip(c.key, c.label))}
      </div>

      {/* Recommended rail (only on the default view) */}
      {cat === 'all' && !q && recommended.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Sparkles className="h-4 w-4 text-brand-text" /> {t('dashboardAppStore.recommendedForYourFamily')}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {recommended.map((a) => (
              <div key={a.id} className="w-60 shrink-0">
                <AppCard app={a} installed={installedIds.has(a.id)} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Installed */}
      {installedApps.length > 0 && cat === 'all' && !q && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('dashboardAppStore.installed')}{installedApps.length})</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rankApps(installedApps).map((a) => <AppCard key={a.id} app={a} installed />)}
          </div>
        </section>
      )}

      {/* Catalog grid */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-fg">
          {cat === 'all' ? 'Browse all apps' : categoryLabel(cat)}{q ? ` · “${q}”` : ''} <span className="text-muted">({visible.length})</span>
        </h2>
        {visible.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">{t('dashboardAppStore.noAppsMatch')}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((a) => <AppCard key={a.id} app={a} installed={installedIds.has(a.id)} />)}
          </div>
        )}
      </section>
    </div>
  );
}

async function AppCard({ app, installed }: { app: CatalogApp; installed: boolean }) {
  const t = await getTranslations();
  return (
    <article className="flex h-full flex-col rounded-2xl border border-border bg-surface/60 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-elevated text-2xl">{app.emoji ?? '✨'}</span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-bold text-fg">
            <span className="truncate">{app.name}</span>
            {app.is_official && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-brand-text" aria-label={t('appStore.official')} />}
          </p>
          <p className="truncate text-[11px] text-muted">{app.publisher} · {categoryLabel(app.category)}</p>
        </div>
      </div>
      {app.tagline && <p className="mt-2 line-clamp-2 text-xs text-muted">{app.tagline}</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted">
          {app.rating != null && <><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{app.rating.toFixed(1)}</>}
        </span>
        <InstallButton appId={app.id} installed={installed} available={app.status !== 'coming_soon'} />
      </div>
    </article>
  );
}
