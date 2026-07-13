import type { Metadata } from 'next';
import { CheckCircle2, XCircle, CreditCard, Mail, Calendar, Database, HardDrive, KeyRound } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { checkDatabase, checkStorage, checkAuth, checkStripe, checkEmail } from '@/lib/server/health';

export const metadata: Metadata = { title: 'Integrations', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Integration = {
  name: string;
  category: string;
  icon: React.ComponentType<{ className?: string }>;
  connected: boolean;
  detail: string;
};

function Row({ integration }: { integration: Integration }) {
  const Icon = integration.icon;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-surface/40 p-4">
      <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium">{integration.name}</p>
          <Badge tone="neutral">{integration.category}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted">{integration.detail}</p>
      </div>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        {integration.connected ? (
          <><CheckCircle2 className="h-4 w-4 text-success" /> <span className="text-success">Connected</span></>
        ) : (
          <><XCircle className="h-4 w-4 text-muted" /> <span className="text-muted">Not configured</span></>
        )}
      </div>
    </div>
  );
}

export default async function AdminIntegrationsPage() {
  const supabase = createServiceClient();

  const [dbCheck, storageCheck, authCheck, stripeCheck, emailCheck, { count: googleCalCount }] = await Promise.all([
    checkDatabase(supabase),
    checkStorage(supabase),
    checkAuth(supabase),
    checkStripe(),
    Promise.resolve(checkEmail()),
    supabase.from('user_preferences').select('user_id', { count: 'exact', head: true })
      .not('notification_prefs->googleCalendarToken', 'is', null),
  ]);

  const integrations: Integration[] = [
    { name: 'Supabase Database', category: 'Core', icon: Database, connected: dbCheck.ok, detail: dbCheck.ok ? `Responding in ${dbCheck.latencyMs}ms` : dbCheck.detail },
    { name: 'Supabase Storage', category: 'Core', icon: HardDrive, connected: storageCheck.ok, detail: storageCheck.ok ? `Responding in ${storageCheck.latencyMs}ms` : storageCheck.detail },
    { name: 'Supabase Auth', category: 'Core', icon: KeyRound, connected: authCheck.ok, detail: authCheck.ok ? `Responding in ${authCheck.latencyMs}ms` : authCheck.detail },
    { name: 'Stripe', category: 'Payments', icon: CreditCard, connected: stripeCheck.ok, detail: stripeCheck.ok ? `Live balance check in ${stripeCheck.latencyMs}ms` : stripeCheck.detail },
    { name: 'Resend', category: 'Email', icon: Mail, connected: emailCheck.ok, detail: emailCheck.detail },
    {
      name: 'Google Calendar', category: 'Productivity', icon: Calendar,
      connected: (googleCalCount ?? 0) > 0,
      detail: `${googleCalCount ?? 0} member${googleCalCount === 1 ? '' : 's'} connected, across all families`,
    },
  ];

  const connectedCount = integrations.filter((i) => i.connected).length;

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Integrations</h1>
        <p className="mt-1 text-sm text-muted">Every third-party service this app actually depends on, and its real connection status.</p>
      </div>

      <div className="grid-stats">
        <div className="stat-card">
          <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xl font-bold leading-none">{connectedCount} / {integrations.length}</p>
            <p className="mt-1 text-xs text-muted">Connected</p>
          </div>
        </div>
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Status</h2>
        <p className="mb-4 text-xs text-muted">
          This list is exactly what&rsquo;s wired into the codebase — no placeholder rows for services that aren&rsquo;t actually integrated.
        </p>
        <div className="space-y-2">
          {integrations.map((i) => <Row key={i.name} integration={i} />)}
        </div>
      </Card>
    </div>
  );
}
