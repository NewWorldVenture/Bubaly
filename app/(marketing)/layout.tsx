import { SiteHeader } from '@/components/marketing/site-header';
import { SiteFooter } from '@/components/marketing/site-footer';
import { RegisterSW } from '@/components/pwa/register-sw';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg transition-colors duration-300">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <RegisterSW />
    </div>
  );
}
