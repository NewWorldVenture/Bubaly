import type { Metadata } from 'next';
import Link from 'next/link';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { Smartphone, Bell, WifiOff, RefreshCw, Tablet, ArrowRight } from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/mobile', {
    title: 'Mobile App',
    description: 'Bubaly goes everywhere your family does — native iOS and Android apps, plus an installable web app.',
  });
}

const POINTS = [
  { icon: Smartphone, title: 'iOS & Android', description: 'Native companion apps built with Expo, sharing the same data and design language as the web.' },
  { icon: Bell, title: 'Push notifications', description: 'Get nudged on your phone for due chores, medications, events, and expiring documents.' },
  { icon: WifiOff, title: 'Offline-friendly', description: 'Recently viewed screens keep working when you lose signal, and sync the moment you’re back.' },
  { icon: RefreshCw, title: 'Real-time sync', description: 'Check off a grocery item on your phone and it updates on everyone’s screen instantly.' },
];

export default async function MobilePage() {
  const t = await getTranslations();
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="Mobile"
          title="Bubaly, in your pocket"
          description="Install the web app today, or use the native iOS and Android companions."
        />
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map((p) => (
            <FeatureCard key={p.title} {...p} />
          ))}
        </div>
        <div className="glass-card mx-auto mt-10 max-w-2xl p-7 text-center">
          <h3 className="text-lg font-semibold">Install the web app right now</h3>
          <p className="mt-2 text-sm text-muted">
            Bubaly is a Progressive Web App. On your phone, open it in your browser and choose
            <span className="font-medium text-fg"> “Add to Home Screen.”</span> It launches
            full-screen, just like a native app.
          </p>
        </div>
      </Section>

      {/* Tablets: Kitchen Mode — the same software on the tablet a family
          already owns. Copy claims only what lib/display and components/display
          ship (arranged widgets, timers, weather, photos, full-screen via Add to
          Home Screen); the /features card holds the illustration. */}
      <Section className="pt-0">
        <div className="glass-card mx-auto flex max-w-3xl flex-col items-center gap-5 p-7 text-center sm:flex-row sm:text-left">
          <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
            <Tablet className="h-7 w-7" aria-hidden />
          </span>
          <div className="flex-1">
            <h2 className="text-2xl font-bold tracking-tight">{t('mobile.kitchenModeTitle')}</h2>
            <p className="mt-2 text-sm text-muted">{t('mobile.kitchenModeBody')}</p>
            <p className="mt-2 text-xs font-medium text-muted">{t('kitchenMode.tier')}</p>
          </div>
          <Link
            href="/features#kitchen-mode"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
          >
            {t('mobile.kitchenModeLink')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </Section>
      <CTASection title="Take Bubaly with you" subtitle="Sign up and install on every device." />
      <MarketingAeoSection path="/mobile" name="Bubaly Mobile App" description="Bubaly goes everywhere your family does with installable web, iOS, and Android experiences." />
    </>
  );
}
