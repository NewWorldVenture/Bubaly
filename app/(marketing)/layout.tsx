import { SiteHeader } from '@/components/marketing/site-header';
import { SiteFooter } from '@/components/marketing/site-footer';
import { RegisterSW } from '@/components/pwa/register-sw';
import { ExitIntent } from '@/components/marketing/exit-intent';
import { CookieConsent } from '@/components/marketing/cookie-consent';
import { BackToTop } from '@/components/marketing/back-to-top';
import { SkipLink } from '@/components/a11y/skip-link';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-theme flex min-h-dvh flex-col bg-bg text-fg transition-colors duration-300">
      <SkipLink />
      <SiteHeader />
      <main id="main-content" className="flex-1">{children}</main>
      <SiteFooter />
      <RegisterSW />
      <ExitIntent />
      <CookieConsent />
      <BackToTop />
    </div>
  );
}
