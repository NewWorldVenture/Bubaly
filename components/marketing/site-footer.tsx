import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { Logo } from '@/components/brand/logo';
import { ConsentReopenLink } from '@/components/marketing/consent-manager';
import { LanguageBar } from '@/components/i18n/language-picker';
import { createServiceClient } from '@/lib/supabase/server';
import { SOCIAL_PLATFORMS, type SocialPlatform } from '@/lib/marketing/social-links';
import { getSocialLinks } from '@/lib/server/social-links';
import {
  FacebookIcon,
  InstagramIcon,
  LinkedinIcon,
  TiktokIcon,
  XIcon,
  YoutubeIcon,
  type SocialIconProps,
} from '@/components/brand/social-icons';

const SOCIAL_ICONS: Record<SocialPlatform, (p: SocialIconProps) => React.JSX.Element> = {
  facebook: FacebookIcon,
  youtube: YoutubeIcon,
  x: XIcon,
  instagram: InstagramIcon,
  linkedin: LinkedinIcon,
  tiktok: TiktokIcon,
};

// Catalogue KEYS, not copy. The footer renders on every marketing page, so a
// literal here is English on every one of them at once — which is exactly what
// happened: these were plain strings, `{l.label}` printed them verbatim, and a
// half-finished migration left one entry reading `siteFooter.acceptableUse` on
// screen because the key was never passed through t(). Keys resolve or fall
// back to English; a raw key on screen is not a state this can reach.
const GROUPS = [
  {
    title: 'siteFooter.product',
    links: [
      { href: '/features', label: 'marketing.nav.features' },
      { href: '/how-it-works', label: 'marketing.nav.howItWorks' },
      { href: '/pricing', label: 'marketing.nav.pricing' },
      { href: '/mobile', label: 'siteFooter.mobileApp' },
      { href: '/ai', label: 'marketing.nav.aiAssistant' },
    ],
  },
  {
    title: 'siteFooter.company',
    links: [
      { href: '/security', label: 'marketing.nav.security' },
      { href: '/blog', label: 'marketing.nav.blog' },
      { href: '/contact', label: 'siteFooter.contact' },
      { href: '/faq', label: 'marketing.nav.faq' },
    ],
  },
  {
    title: 'marketing.getStarted',
    links: [
      { href: '/signup', label: 'siteFooter.createAccount' },
      { href: '/login', label: 'marketing.logIn' },
    ],
  },
  {
    title: 'siteFooter.legal',
    links: [
      { href: '/privacy', label: 'siteFooter.privacyPolicy' },
      { href: '/terms', label: 'siteFooter.termsOfService' },
      { href: '/acceptable-use', label: 'siteFooter.acceptableUse' },
      { href: '/cookies', label: 'siteFooter.cookiePolicy' },
    ],
  },
];

export async function SiteFooter() {
  const t = await getTranslations();
  const social = await getSocialLinks(createServiceClient());
  const configured = SOCIAL_PLATFORMS.filter((p) => social[p.key]);

  return (
    <footer className="border-t border-border/70 bg-bg text-fg transition-colors duration-300">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-3 lg:grid-cols-6 lg:px-10">
        <div className="col-span-2 md:col-span-3 lg:col-span-2">
          <Logo />
          <p className="mt-3 max-w-[240px] text-[11px] font-semibold leading-5 text-muted">{t('siteFooter.lessManagingLifeMoreLiving')}</p>
          <p className="mt-2 max-w-[240px] text-[11px] leading-5 text-muted">{t('siteFooter.theAiOperatingSystemFor')}</p>
          <div className="mt-5">
            <LanguageBar />
          </div>
        </div>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h4 className="text-[11px] font-semibold text-fg">{t(g.title)}</h4>
            <ul className="mt-3 space-y-2.5">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[10px] text-muted transition hover:text-fg">
                    {t(l.label)}
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
          <p>{t('siteFooter.allRightsReserved', { year: new Date().getFullYear() })}</p>

          {/* Only the accounts an admin has actually filled in — an empty set
              renders nothing rather than a row of links to nowhere. */}
          {configured.length > 0 && (
            <nav aria-label={t('siteFooter.bubalyOnSocialMedia')} className="flex items-center gap-2">
              {configured.map(({ key, label }) => {
                const Icon = SOCIAL_ICONS[key];
                return (
                  <a
                    key={key}
                    href={social[key]}
                    target="_blank"
                    rel="me noopener noreferrer"
                    aria-label={t('siteFooter.bubalyOn', { platform: label })}
                    className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-elevated hover:text-fg focus-ring"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </nav>
          )}

          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <Link href="/privacy" className="transition hover:text-fg">{t('siteFooter.privacy')}</Link>
            <Link href="/terms" className="transition hover:text-fg">{t('siteFooter.terms')}</Link>
            <Link href="/acceptable-use" className="transition hover:text-fg">{t('siteFooter.acceptableUse')}</Link>
            <Link href="/cookies" className="transition hover:text-fg">{t('siteFooter.cookies')}</Link>
            <ConsentReopenLink />
          </nav>
        </div>
      </div>
    </footer>
  );
}
