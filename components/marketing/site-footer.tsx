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

// `label` is the English source of truth; `labelKey` is what renders through
// t(). Every group title and link resolves the same way, so a footer link can
// never show a raw catalogue key or an untranslated word.
type FooterLink = { href: string; label: string; labelKey: string };
type FooterGroup = { title: string; titleKey: string; links: FooterLink[] };

const GROUPS: FooterGroup[] = [
  {
    title: 'Product',
    titleKey: 'siteFooter.product',
    links: [
      { href: '/features', label: 'What Bubaly handles', labelKey: 'siteFooter.whatBubalyHandles' },
      { href: '/how-it-works', label: 'How it works', labelKey: 'siteFooter.howItWorks' },
      { href: '/pricing', label: 'Pricing', labelKey: 'siteFooter.pricing' },
      { href: '/mobile', label: 'Mobile app', labelKey: 'siteFooter.mobileApp' },
      { href: '/features#kitchen-mode', label: 'Kitchen Mode', labelKey: 'siteFooter.kitchenMode' },
      { href: '/ai', label: 'Handled for you', labelKey: 'siteFooter.handledForYou' },
    ],
  },
  {
    title: 'Company',
    titleKey: 'siteFooter.company',
    links: [
      { href: '/security', label: 'Trust Center', labelKey: 'siteFooter.trustCenter' },
      { href: '/blog', label: 'Blog', labelKey: 'siteFooter.blog' },
      { href: '/contact', label: 'Contact', labelKey: 'siteFooter.contact' },
      { href: '/faq', label: 'FAQ', labelKey: 'siteFooter.faq' },
    ],
  },
  {
    title: 'Get started',
    titleKey: 'siteFooter.getStarted',
    links: [
      { href: '/signup', label: 'Create account', labelKey: 'siteFooter.createAccount' },
      { href: '/login', label: 'Log in', labelKey: 'siteFooter.logIn' },
      { href: '/dashboard/migrate', label: 'Switch to Bubaly', labelKey: 'siteFooter.switchToBubaly' },
    ],
  },
  {
    title: 'Legal',
    titleKey: 'siteFooter.legal',
    links: [
      { href: '/privacy', label: 'Privacy Policy', labelKey: 'siteFooter.privacyPolicy' },
      { href: '/terms', label: 'Terms of Service', labelKey: 'siteFooter.termsOfService' },
      { href: '/acceptable-use', label: 'Acceptable Use', labelKey: 'siteFooter.acceptableUse' },
      { href: '/cookies', label: 'Cookie Policy', labelKey: 'siteFooter.cookiePolicy' },
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
          <p>© {new Date().getFullYear()} Bubaly. All rights reserved.</p>

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
                    aria-label={`Bubaly on ${label}`}
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
