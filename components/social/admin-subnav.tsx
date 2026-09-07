import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';

const ITEMS = [
  { href: '/admin/social', label: 'Overview' },
  { href: '/admin/social/providers', label: 'Providers' },
  { href: '/admin/social/audit', label: 'Audit' },
  { href: '/admin/social/usage', label: 'Usage' },
];

export async function AdminSocialSubnav({ active }: { active: string }) {
  const t = await getTranslations();
  return (
    <nav className="flex flex-wrap gap-2" aria-label={t('adminSubnav.adminSocialSections')}>
      {ITEMS.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${active === i.href ? 'bg-brand text-brand-fg' : 'border border-border text-muted hover:text-fg'}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
