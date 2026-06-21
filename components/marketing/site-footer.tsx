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
  return (
    <footer className="border-t border-border/70 bg-bg text-fg transition-colors duration-300">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-4 lg:px-10">
        <div className="col-span-2 md:col-span-1">
          <Logo />
          <p className="mt-3 max-w-[220px] text-[11px] leading-5 text-muted">
            Run your family like a calm, connected team.
          </p>
        </div>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h4 className="text-[11px] font-semibold text-fg">{g.title}</h4>
            <ul className="mt-3 space-y-2.5">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[10px] text-muted transition hover:text-fg">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
