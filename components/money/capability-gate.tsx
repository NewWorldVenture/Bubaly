'use client';

import type { CapabilityStatus, StripeCapabilityMatrix } from '@/lib/stripe/capabilities';
import { isEnabled } from '@/lib/stripe/capabilities';
import { AlertCircle, Clock, Zap } from 'lucide-react';

type Props = {
  capability: CapabilityStatus;
  fallback?: React.ReactNode;
  children: React.ReactNode;
  /** If provided, shown instead of the generic pending/unavailable message. */
  pendingMessage?: string;
  unavailableMessage?: string;
};

export function CapabilityGate({ capability, fallback, children, pendingMessage, unavailableMessage }: Props) {
  if (isEnabled(capability)) return <>{children}</>;

  if (fallback) return <>{fallback}</>;

  if (capability === 'pending_review') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <p className="text-amber-800 dark:text-amber-300">
          {pendingMessage ?? "This feature is pending Stripe review. We'll notify you when it's approved."}
        </p>
      </div>
    );
  }

  if (capability === 'action_required') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/30">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <p className="text-red-800 dark:text-red-300">
          Action required in your Stripe dashboard to enable this feature.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface/50 p-4 text-sm">
      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <p className="text-muted">
        {unavailableMessage ?? 'This feature requires Bubaly Money setup.'}
      </p>
    </div>
  );
}

/** Higher-order convenience: gate on any key of the capability matrix being 'enabled'. */
export function MoneyGate({
  caps,
  feature,
  children,
  fallback,
}: {
  caps: StripeCapabilityMatrix;
  feature: keyof Pick<StripeCapabilityMatrix,
    'payments' | 'issuing' | 'virtualCards' | 'physicalCards' |
    'treasury' | 'ach' | 'instantPayout' | 'cardPersonalization' | 'realtimeAuthorizations'>;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return (
    <CapabilityGate capability={caps[feature]} fallback={fallback}>
      {children}
    </CapabilityGate>
  );
}
