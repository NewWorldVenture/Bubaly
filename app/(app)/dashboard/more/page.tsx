import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { navLabel } from '@/lib/i18n/nav-label';

type Translate = Awaited<ReturnType<typeof getTranslations>>;
import Link from 'next/link';
import { Lock, ShieldCheck, HelpCircle, Mail, Info, FileText, ChevronRight, LayoutGrid } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('more.more') };
}

// Screen 11 of the mockups: the t('more.more') menu — a hub for account security and the
// info/legal pages. Manage PIN jumps to the App Lock card in Settings; the rest
// link to the existing public pages. Lives in the (app) group, so it sits behind
// auth + the App Lock gate like every other dashboard page.
// `label` is a navigation label (translated through navLabel); `sub` is a catalogue key.
type Row = { href: string; label: string; sub: string; icon: LucideIcon; external?: boolean };

const BROWSE: Row[] = [
  { href: '/services', label: 'All Services', sub: 'more.allServicesSub', icon: LayoutGrid },
];

const ACCOUNT: Row[] = [
  { href: '/dashboard/settings#app-lock', label: 'Manage PIN', sub: 'more.managePinSub', icon: Lock },
];

const INFO: Row[] = [
  { href: '/privacy', label: 'Privacy', sub: 'more.privacySub', icon: ShieldCheck, external: true },
  { href: '/faq', label: 'Help', sub: 'more.helpSub', icon: HelpCircle, external: true },
  { href: '/contact', label: 'Contact', sub: 'more.contactSub', icon: Mail, external: true },
  { href: '/how-it-works', label: 'About', sub: 'more.aboutSub', icon: Info, external: true },
  { href: '/terms', label: 'Terms', sub: 'more.termsSub', icon: FileText, external: true },
];

function LinkRow({ row, t }: { row: Row; t: Translate }) {
  const { icon: Icon } = row;
  return (
    <Link
      href={row.href}
      {...(row.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-elevated"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{navLabel(t, row.label)}</span>
        <span className="block truncate text-xs text-muted">{t(row.sub)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
    </Link>
  );
}

function Group({ title, rows, t }: { title: string; rows: Row[]; t: Translate }) {
  return (
    <section>
      <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {rows.map((r) => <LinkRow key={r.href} row={r} t={t} />)}
      </div>
    </section>
  );
}

export default async function MorePage() {
  const t = await getTranslations();
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">{t('more.more')}</h1>
      <div className="space-y-6">
        <Group title={t('more.browse')} rows={BROWSE} t={t} />
        <Group title={t('more.account')} rows={ACCOUNT} t={t} />
        <Group title={t('more.information')} rows={INFO} t={t} />
      </div>
      <p className="mt-8 text-center text-xs text-muted">{t('more.bubalyLessManagingLifeMore')}</p>
    </div>
  );
}
