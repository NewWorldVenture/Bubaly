'use client';

import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { isAdmin } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';
import type { SubscriptionStatus } from '@/lib/database.types';

type Subscription = Tables<'subscriptions'>;

const STATUS_CONFIG: Record<SubscriptionStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; icon: React.ReactNode }> = {
  trialing: { label: 'Trial', tone: 'brand' as 'neutral', icon: <Clock className="h-4 w-4" /> },
  active: { label: 'Active', tone: 'success', icon: <CheckCircle2 className="h-4 w-4" /> },
  past_due: { label: 'Past due', tone: 'warning', icon: <AlertCircle className="h-4 w-4" /> },
  canceled: { label: 'Canceled', tone: 'neutral', icon: <AlertCircle className="h-4 w-4" /> },
  incomplete: { label: 'Incomplete', tone: 'warning', icon: <AlertCircle className="h-4 w-4" /> },
  incomplete_expired: { label: 'Expired', tone: 'danger', icon: <AlertCircle className="h-4 w-4" /> },
  unpaid: { label: 'Unpaid', tone: 'danger', icon: <AlertCircle className="h-4 w-4" /> },
};

const PLAN_LABELS: Record<string, { name: string; description: string; price: string }> = {
  free: { name: 'Free', description: 'Basic family coordination for up to 2 members.', price: '$0/mo' },
  family: { name: 'FamilyOS Family', description: 'Everything you need — unlimited members, AI assistant, and all modules.', price: '$9.99/mo' },
  family_annual: { name: 'FamilyOS Family (Annual)', description: 'Save 20% with an annual subscription.', price: '$95.99/yr' },
};

export function BillingModule() {
  const { familyId, role } = useApp();
  const admin = isAdmin(role);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.from('subscriptions').select('*').eq('family_id', familyId).maybeSingle()
      .then(({ data }) => { setSubscription(data); setLoading(false); });
  }, [familyId]);

  if (loading) return <LoadingBlock />;

  const status = subscription?.status ?? 'trialing';
  const config = STATUS_CONFIG[status];
  const plan = PLAN_LABELS[subscription?.plan ?? 'free'] ?? PLAN_LABELS.free;
  const hasActiveAccess = ['active', 'trialing'].includes(status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Manage your FamilyOS subscription and billing details."
      />

      {/* Current plan */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Current plan</h2>
          <Badge tone={config.tone as 'success' | 'warning' | 'danger' | 'neutral'}>
            <span className="flex items-center gap-1">{config.icon} {config.label}</span>
          </Badge>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xl font-bold">{plan.name}</p>
            <p className="mt-1 text-sm text-muted">{plan.description}</p>
            {subscription?.current_period_end && (
              <p className="mt-2 text-sm text-muted">
                {['canceled', 'incomplete_expired'].includes(status) ? 'Access until' : 'Renews'}{' '}
                {fmtDate(subscription.current_period_end)}
              </p>
            )}
          </div>
          <p className="shrink-0 text-2xl font-bold text-brand">{plan.price}</p>
        </div>
      </Card>

      {/* Upgrade CTA if on free / trial */}
      {(!subscription || status === 'trialing' || status === 'canceled') && admin && (
        <Card className="bg-gradient-to-br from-brand/10 to-accent/10">
          <h2 className="text-base font-semibold">Upgrade to FamilyOS Family</h2>
          <p className="mt-1 text-sm text-muted">
            Get unlimited family members, AI assistant, all modules, and priority support.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface/60 p-4">
              <p className="font-semibold">Monthly</p>
              <p className="mt-1 text-2xl font-bold">$9.99<span className="text-sm font-normal text-muted">/mo</span></p>
              <Button className="mt-3 w-full" onClick={() => alert('Stripe integration coming in Phase 8.')}>
                Get started
              </Button>
            </div>
            <div className="rounded-xl border border-brand/40 bg-brand/5 p-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold">Annual</p>
                <Badge tone="success">Save 20%</Badge>
              </div>
              <p className="mt-1 text-2xl font-bold">$7.99<span className="text-sm font-normal text-muted">/mo</span></p>
              <Button className="mt-3 w-full" onClick={() => alert('Stripe integration coming in Phase 8.')}>
                Get annual
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Feature list */}
      <Card>
        <h2 className="mb-4 text-base font-semibold">What's included</h2>
        <ul className="space-y-2">
          {[
            'Unlimited family members',
            'Family calendar with recurring events',
            'Chores & rewards with points',
            'Meal planning & grocery lists',
            'AI family assistant',
            'Health & medication tracking',
            'School & sports event management',
            'Home asset & maintenance tracking',
            'Document vault',
            'Goals & progress tracking',
            'Real-time sync across all devices',
            'Mobile app (iOS & Android)',
          ].map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm">
              <CheckCircle2 className={`h-4 w-4 shrink-0 ${hasActiveAccess ? 'text-success' : 'text-muted'}`} />
              <span className={hasActiveAccess ? '' : 'text-muted'}>{f}</span>
            </li>
          ))}
        </ul>
      </Card>

      {!admin && (
        <p className="text-center text-sm text-muted">Contact your family admin to manage billing.</p>
      )}
    </div>
  );
}
