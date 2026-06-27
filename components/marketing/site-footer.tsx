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
  {
    title: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/terms', label: 'Terms of Service' },
      { href: '/acceptable-use', label: 'Acceptable Use' },
      { href: '/cookies', label: 'Cookie Policy' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70 bg-bg text-fg transition-colors duration-300">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-3 lg:grid-cols-6 lg:px-10">
        <div className="col-span-2 md:col-span-3 lg:col-span-2">
          <Logo />
          <p className="mt-3 max-w-[240px] text-[11px] font-semibold leading-5 text-muted">
            Less Life Admin. More Living Life.
          </p>
          <p className="mt-2 max-w-[240px] text-[11px] leading-5 text-muted">
            The AI operating system for family life.
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

      {/* Bottom legal bar */}
      <div className="border-t border-border/60">
        <div className="mx-auto flex max-w-[1440px] flex-col items-center justify-between gap-3 px-5 py-5 text-[11px] text-muted sm:flex-row sm:px-8 lg:px-10">
          <p>© {new Date().getFullYear()} Bubaly. All rights reserved.</p>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <Link href="/privacy" className="transition hover:text-fg">Privacy</Link>
            <Link href="/terms" className="transition hover:text-fg">Terms</Link>
            <Link href="/acceptable-use" className="transition hover:text-fg">Acceptable Use</Link>
            <Link href="/cookies" className="transition hover:text-fg">Cookies</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
