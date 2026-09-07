import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { ConsentReopenLink } from '@/components/marketing/consent-manager';
import { LanguageBar } from '@/components/i18n/language-picker';
import { getTranslations } from '@/lib/i18n/server';
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

// Every label here is a catalogue key, not a literal. The footer is the one
// component on every marketing page AND the home of the language control: a
// visitor who switches language is looking straight at it when the page
// repaints, so English left here is English in the most conspicuous place on
// the site. `labelKey` mirrors the convention in lib/constants/navigation.ts.
const GROUPS = [
  {
    titleKey: 'marketing.footer.group.product',
    links: [
      { href: '/features', labelKey: 'marketing.footer.link.features' },
      { href: '/how-it-works', labelKey: 'marketing.footer.link.howItWorks' },
      { href: '/pricing', labelKey: 'marketing.footer.link.pricing' },
      { href: '/mobile', labelKey: 'marketing.footer.link.mobileApp' },
      { href: '/ai', labelKey: 'marketing.footer.link.aiAssistant' },
    ],
  },
  {
    titleKey: 'marketing.footer.group.company',
    links: [
      { href: '/security', labelKey: 'marketing.footer.link.security' },
      { href: '/blog', labelKey: 'marketing.footer.link.blog' },
      { href: '/contact', labelKey: 'marketing.footer.link.contact' },
      { href: '/faq', labelKey: 'marketing.footer.link.faq' },
    ],
  },
  {
    titleKey: 'marketing.footer.group.getStarted',
    links: [
      { href: '/signup', labelKey: 'marketing.footer.link.createAccount' },
      { href: '/login', labelKey: 'marketing.footer.link.logIn' },
    ],
  },
  {
    titleKey: 'marketing.footer.group.legal',
    links: [
      { href: '/privacy', labelKey: 'marketing.footer.link.privacyPolicy' },
      { href: '/terms', labelKey: 'marketing.footer.link.termsOfService' },
      { href: '/acceptable-use', labelKey: 'marketing.footer.link.acceptableUse' },
      { href: '/cookies', labelKey: 'marketing.footer.link.cookiePolicy' },
    ],
  },
];

const LEGAL_BAR = [
  { href: '/privacy', labelKey: 'marketing.footer.legal.privacy' },
  { href: '/terms', labelKey: 'marketing.footer.legal.terms' },
  { href: '/acceptable-use', labelKey: 'marketing.footer.legal.acceptableUse' },
  { href: '/cookies', labelKey: 'marketing.footer.legal.cookies' },
];

export async function SiteFooter() {
  const [t, social] = await Promise.all([
    getTranslations(),
    getSocialLinks(createServiceClient()),
  ]);
  const configured = SOCIAL_PLATFORMS.filter((p) => social[p.key]);

  return (
    <footer className="border-t border-border/70 bg-bg text-fg transition-colors duration-300">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-8 px-5 py-10 sm:px-8 md:grid-cols-3 lg:grid-cols-6 lg:px-10">
        <div className="col-span-2 md:col-span-3 lg:col-span-2">
          <Logo />
          <p className="mt-3 max-w-[240px] text-[11px] font-semibold leading-5 text-muted">
            {t('marketing.footer.tagline')}
          </p>
          <p className="mt-2 max-w-[240px] text-[11px] leading-5 text-muted">
            {t('marketing.footer.description')}
          </p>
          <div className="mt-5">
            <LanguageBar />
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
          <p>{t('marketing.footer.copyright', { year: new Date().getFullYear() })}</p>

          {/* Only the accounts an admin has actually filled in — an empty set
              renders nothing rather than a row of links to nowhere. */}
          {configured.length > 0 && (
            <nav aria-label={t('marketing.footer.socialNavLabel')} className="flex items-center gap-2">
              {configured.map(({ key, label }) => {
                const Icon = SOCIAL_ICONS[key];
                return (
                  <a
                    key={key}
                    href={social[key]}
                    target="_blank"
                    rel="me noopener noreferrer"
                    aria-label={t('marketing.footer.socialLinkLabel', { platform: label })}
                    className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-elevated hover:text-fg focus-ring"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </nav>
          )}

          <nav aria-label={t('marketing.footer.legalNavLabel')} className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {LEGAL_BAR.map((l) => (
              <Link key={l.href} href={l.href} className="transition hover:text-fg">
                {t(l.labelKey)}
              </Link>
            ))}
            <ConsentReopenLink />
          </nav>
        </div>
      </div>
    </footer>
  );
}
