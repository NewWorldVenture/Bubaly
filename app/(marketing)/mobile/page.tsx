import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { Smartphone, Bell, WifiOff, RefreshCw } from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

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

export default function MobilePage() {
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
      <CTASection title="Take Bubaly with you" subtitle="Sign up and install on every device." />
    </>
  );
}
