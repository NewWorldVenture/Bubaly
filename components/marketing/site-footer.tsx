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
    <footer className="dark border-t border-white/[0.055] bg-[#030911] text-white">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-4 lg:px-10">
        <div className="col-span-2 md:col-span-1">
          <Logo className="[&>span:first-child]:h-6 [&>span:first-child]:w-7 [&>span:last-child]:text-[18px]" />
          <p className="mt-3 max-w-[220px] text-[11px] leading-5 text-white/42">
            Run your family like a calm, connected team.
          </p>
        </div>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h4 className="text-[11px] font-semibold text-white/88">{g.title}</h4>
            <ul className="mt-3 space-y-2.5">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[10px] text-white/42 transition hover:text-white">
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
