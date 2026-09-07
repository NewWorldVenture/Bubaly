import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import Link from 'next/link';
import { Lock, ShieldCheck, HelpCircle, Mail, Info, FileText, ChevronRight, LayoutGrid } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const metadata: Metadata = { title: 'more.more' };

// Screen 11 of the mockups: the "More" menu — a hub for account security and the
// info/legal pages. Manage PIN jumps to the App Lock card in Settings; the rest
// link to the existing public pages. Lives in the (app) group, so it sits behind
// auth + the App Lock gate like every other dashboard page.
type Row = { href: string; label: string; sub: string; icon: LucideIcon; external?: boolean };

const BROWSE: Row[] = [
  { href: '/services', label: 'All Services', sub: 'Browse every feature by category', icon: LayoutGrid },
];

const ACCOUNT: Row[] = [
  { href: '/dashboard/settings#app-lock', label: 'Manage PIN', sub: 'Set, change or turn off your App Lock', icon: Lock },
];

const INFO: Row[] = [
  { href: '/privacy', label: 'Privacy', sub: 'How we protect your family’s data', icon: ShieldCheck, external: true },
  { href: '/faq', label: 'Help', sub: 'Answers to common questions', icon: HelpCircle, external: true },
  { href: '/contact', label: 'Contact', sub: 'Get in touch with our team', icon: Mail, external: true },
  { href: '/how-it-works', label: 'About', sub: 'What Bubaly is and how it works', icon: Info, external: true },
  { href: '/terms', label: 'Terms', sub: 'Terms of service', icon: FileText, external: true },
];

function LinkRow({ row }: { row: Row }) {
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
        <span className="block text-sm font-medium">{row.label}</span>
        <span className="block truncate text-xs text-muted">{row.sub}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
    </Link>
  );
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {rows.map((r) => <LinkRow key={r.href} row={r} />)}
      </div>
    </section>
  );
}

export default async function MorePage() {
  const t = await getTranslations();
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">More</h1>
      <div className="space-y-6">
        <Group title={t('more.browse')} rows={BROWSE} />
        <Group title={t('more.account')} rows={ACCOUNT} />
        <Group title={t('more.information')} rows={INFO} />
      </div>
      <p className="mt-8 text-center text-xs text-muted">{t('more.bubalyLessManagingLifeMore')}</p>
    </div>
  );
}
