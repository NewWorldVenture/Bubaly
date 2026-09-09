import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Monitor } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
// Only PascalCase components and type-only imports may cross from a 'use client'
// module into server code here — the RSC boundary rule that app/(app)/display/
// page.tsx documents at length (tests/display-server-safety.test.ts).
import { DisplaySelfCheck } from '@/components/display/display-self-check';

// The tab title is copy too: a family reading the app in German should not find
// one English string sitting in the browser tab.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('displaySetup.setUpThisDisplay'), robots: { index: false } };
}

export const dynamic = 'force-dynamic';

// The in-app setup guide for a tablet that is about to live on a wall.
//
// Reached from the display header (the monitor button next to the pencil), not
// from the sidebar. It reads nothing from the database — it is instructions and
// one self-check — so there is no read here that could fail open.
//
// The checklist deliberately describes what a PERSON does on the device; the
// only claims the page makes about THIS tablet come from "Test this display",
// which measures four things and reports exactly those four.
const STEPS = [
  { titleKey: 'displaySetup.stepInstallTitle', bodyKey: 'displaySetup.stepInstallBody' },
  { titleKey: 'displaySetup.stepFullscreenTitle', bodyKey: 'displaySetup.stepFullscreenBody' },
  { titleKey: 'displaySetup.stepAwakeTitle', bodyKey: 'displaySetup.stepAwakeBody' },
  { titleKey: 'displaySetup.stepPinningTitle', bodyKey: 'displaySetup.stepPinningBody' },
  { titleKey: 'displaySetup.stepOrientationTitle', bodyKey: 'displaySetup.stepOrientationBody' },
  { titleKey: 'displaySetup.stepRefreshTitle', bodyKey: 'displaySetup.stepRefreshBody' },
];

export default async function DisplaySetupPage() {
  await requireFeature('/display');
  const t = await getTranslations();

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <Link href="/display" aria-label={t('displaySetup.backToTheDisplay')} className="rounded-lg p-1.5 text-muted transition hover:bg-surface">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Monitor className="h-5 w-5 text-brand-text" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">{t('displaySetup.setUpThisDisplay')}</h1>
          <p className="text-sm text-muted">{t('displaySetup.subtitle')}</p>
        </div>
      </div>

      <ol className="space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.titleKey} className="flex gap-3 rounded-2xl border border-border bg-surface/50 p-4">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-sm font-bold text-brand-text">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h2 className="font-semibold">{t(step.titleKey)}</h2>
              <p className="mt-1 text-sm text-muted">{t(step.bodyKey)}</p>
            </div>
          </li>
        ))}
      </ol>

      <DisplaySelfCheck />

      <div className="rounded-2xl border border-border bg-surface/50 p-5">
        <h2 className="text-lg font-semibold">{t('displaySetup.whichTablet')}</h2>
        <p className="mt-1 text-sm text-muted">{t('displaySetup.whichTabletBody')}</p>
        <Link
          href="/family-display"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface"
        >
          {t('displaySetup.seeTheDeviceList')} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <p className="text-center text-sm">
        <Link href="/display" className="font-medium text-brand-text hover:underline">
          {t('displaySetup.backToTheDisplay')}
        </Link>
      </p>
    </div>
  );
}
