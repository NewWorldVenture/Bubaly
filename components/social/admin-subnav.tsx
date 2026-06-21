import Link from 'next/link';

const ITEMS = [
  { href: '/admin/social', label: 'Overview' },
  { href: '/admin/social/providers', label: 'Providers' },
  { href: '/admin/social/audit', label: 'Audit' },
  { href: '/admin/social/usage', label: 'Usage' },
];

export function AdminSocialSubnav({ active }: { active: string }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Admin social sections">
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
