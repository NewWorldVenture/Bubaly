import { SiteHeader } from '@/components/marketing/site-header';
import { SiteFooter } from '@/components/marketing/site-footer';
import { RegisterSW } from '@/components/pwa/register-sw';

/**
 * Marketing / landing pages render on the brand's dark canvas in both themes.
 * The experience is built around dark product showcases and device mockups, so
 * it's deliberately scoped to the dark palette (the `dark` class re-binds the
 * design tokens for this subtree, independent of the global toggle). The theme
 * toggle stays in the header — it sets the preference that applies to the
 * authenticated app, where light/dark fully adapt.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark flex min-h-dvh flex-col bg-[#030911] text-white">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <RegisterSW />
    </div>
  );
}
