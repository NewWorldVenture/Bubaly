import type { Metadata } from 'next';
import { Clock } from 'lucide-react';
import { DemoUpgradeChoices } from '@/components/demo/demo-upgrade-choices';

export const metadata: Metadata = { title: 'Your demo has ended', robots: { index: false, follow: false } };

/**
 * Shown when an email that has ALREADY used its one 5-minute demo tries to demo
 * again (the email gate routes here instead of starting a new clock). Mirrors the
 * end-of-demo pop-up: pick a plan to keep going. A paid plan → signup → payment.
 */
export default function DemoUsedUpgradePage() {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-12 text-fg">
      <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-7 shadow-2xl sm:p-8">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 ring-1 ring-brand/30">
          <Clock className="h-6 w-6 text-brand-text" />
        </div>
        <h1 className="mt-4 text-2xl font-black">You’ve already used your free demo ⏱️</h1>
        <p className="mt-2 text-sm text-white/65">
          Each email gets one 5-minute demo — and yours is done. Make it your family’s for real:
          pick a plan to keep going. A real account starts fresh and stays.
        </p>

        <DemoUpgradeChoices />

        <p className="mt-4 text-center text-xs text-white/45">
          Start free for 5 days — no card needed — or jump straight to a plan.
        </p>
      </div>
    </div>
  );
}
