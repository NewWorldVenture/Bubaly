import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { Logo } from '@/components/brand/logo';
import { ConsentReopenLink } from '@/components/marketing/consent-manager';
import { LanguageBar } from '@/components/i18n/language-picker';
import { SOCIAL_PLATFORMS, resolveSocialLinks, type SocialPlatform } from '@/lib/marketing/social-links';
import { getCachedSocialLinks } from '@/lib/server/social-links';
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

// Every entry is a catalogue key rendered through t(), never a literal. A
// previous pass converted only part of this list and left one key sitting in a
// `label` field that renders verbatim — so the live footer read
// "siteFooter.acceptableUse" to every visitor. Naming the field `titleKey`/
// `labelKey` is what stops that: a key in a field called `label` looks fine,
// a literal in a field called `labelKey` does not.
const GROUPS = [
  {
    titleKey: 'siteFooter.group.product',
    links: [
      { href: '/features', labelKey: 'siteFooter.link.features' },
      { href: '/how-it-works', labelKey: 'siteFooter.link.howItWorks' },
      { href: '/pricing', labelKey: 'siteFooter.link.pricing' },
      { href: '/mobile', labelKey: 'siteFooter.link.mobileApp' },
      { href: '/ai', labelKey: 'siteFooter.link.aiAssistant' },
    ],
  },
  {
    titleKey: 'siteFooter.group.company',
    links: [
      { href: '/security', labelKey: 'siteFooter.link.security' },
      { href: '/blog', labelKey: 'siteFooter.link.blog' },
      { href: '/contact', labelKey: 'siteFooter.link.contact' },
      { href: '/faq', labelKey: 'siteFooter.link.faq' },
    ],
  },
  {
    titleKey: 'siteFooter.group.getStarted',
    links: [
      { href: '/signup', labelKey: 'siteFooter.link.createAccount' },
      { href: '/login', labelKey: 'siteFooter.link.logIn' },
    ],
  },
  {
    titleKey: 'siteFooter.group.legal',
    links: [
      { href: '/privacy', labelKey: 'siteFooter.link.privacyPolicy' },
      { href: '/terms', labelKey: 'siteFooter.link.termsOfService' },
      { href: '/acceptable-use', labelKey: 'siteFooter.acceptableUse' },
      { href: '/cookies', labelKey: 'siteFooter.link.cookiePolicy' },
    ],
  },
];

export async function SiteFooter() {
  const t = await getTranslations();
  // Every platform draws: an admin-saved URL where there is one, the brand's
  // canonical handle otherwise. The row is part of the footer's design rather
  // than something that appears only once someone has filled a form in.
  const social = resolveSocialLinks(await getCachedSocialLinks());

  return (
    <footer className="border-t border-border/70 bg-bg text-fg transition-colors duration-300">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-3 lg:grid-cols-6 lg:px-10">
        <div className="col-span-2 md:col-span-3 lg:col-span-2">
          <Logo />
          <p className="mt-3 max-w-[240px] text-[11px] font-semibold leading-5 text-muted">{t('siteFooter.lessManagingLifeMoreLiving')}</p>
          <p className="mt-2 max-w-[240px] text-[11px] leading-5 text-muted">{t('siteFooter.theAiOperatingSystemFor')}</p>
          {/* Language and the social accounts share one row: both are "where
              else can I go / in what language", and a visitor who has just
              switched language is looking right here. Wraps rather than
              overflowing when six accounts are configured on a narrow phone.
              gap-y is deliberately larger than gap-x: once it wraps — which is
              the normal state in this narrow column — the pill and the icon row
              read as two separate controls stacked, and 8px left them looking
              like one crowded block. */}
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-4">
            <LanguageBar />
            <nav aria-label={t('siteFooter.bubalyOnSocialMedia')} className="flex items-center gap-1">
              {SOCIAL_PLATFORMS.map(({ key, label }) => {
                const Icon = SOCIAL_ICONS[key];
                return (
                  <a
                    key={key}
                    href={social[key]}
                    target="_blank"
                    rel="me noopener noreferrer"
                    aria-label={t('siteFooter.bubalyOn', { platform: label })}
                    className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-elevated hover:text-fg coarse:min-h-11 coarse:min-w-11 focus-ring"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </nav>
          </div>
        </div>
        {GROUPS.map((g) => (
          <div key={g.titleKey}>
            <h4 className="text-[11px] font-semibold text-fg">{t(g.titleKey)}</h4>
            <ul className="mt-3 space-y-2.5">
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[10px] text-muted transition hover:text-fg">
                    {t(l.labelKey)}
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
          <p>{t('siteFooter.copyright', { year: new Date().getFullYear() })}</p>

          <nav aria-label={t('siteFooter.legalNavLabel')} className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
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
