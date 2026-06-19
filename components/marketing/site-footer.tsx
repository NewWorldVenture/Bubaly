import Link from 'next/link';
import { Logo } from '@/components/brand/logo';

const GROUPS = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
      { href: '/how-it-works', label: 'How it works' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/mobile', label: 'Mobile app' },
      { href: '/ai', label: 'AI assistant' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/security', label: 'Security' },
      { href: '/blog', label: 'Blog' },
      { href: '/contact', label: 'Contact' },
      { href: '/faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Get started',
    links: [
      { href: '/signup', label: 'Create account' },
      { href: '/login', label: 'Log in' },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/60 bg-surface/30">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-8">
        <div className="col-span-2 md:col-span-1">
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-muted">
            Run your family like a calm, connected team.
          </p>
        </div>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h4 className="text-sm font-semibold">{g.title}</h4>
            <ul className="mt-3 space-y-2">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-muted transition hover:text-fg">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/60 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 text-xs text-muted sm:flex-row">
          <p>© {year} FamilyOS. All rights reserved.</p>
          <p>Built with care for busy households.</p>
        </div>
      </div>
    </footer>
  );
}
