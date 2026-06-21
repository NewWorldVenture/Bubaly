import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Car, CalendarClock, ShieldCheck, Phone, AlertTriangle, Plus, KeyRound, Stethoscope,
} from 'lucide-react';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getAutoOverview } from '@/lib/auto/queries';
import { vehicleLabel, dueSoonCount } from '@/lib/auto/renewals';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Auto · Overview' };
export const dynamic = 'force-dynamic';

export default async function AutoOverviewPage() {
  const ctx = await requirePlanLevel(1);
  const { vehicles, policies, rentals, renewals } = await getAutoOverview(ctx.active.familyId);

  const activePolicies = policies.filter((p) => p.is_active);
  const activeRental = rentals.find((r) => r.status === 'active' || r.status === 'upcoming');
  const dueSoon = dueSoonCount(renewals, 30);

  if (vehicles.length === 0 && policies.length === 0 && renewals.length === 0) {
    return (
      <EmptyState
        icon={Car}
        title="Set up your garage"
        description="Add a vehicle, your driver's license, registration, inspection, and insurance — all with renewal reminders and one-tap emergency access."
        action={<Link href="/dashboard/auto/vehicles" className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Plus className="h-4 w-4" /> Add a vehicle</Link>}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid-stats">
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand"><Car className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{vehicles.length}</p><p className="mt-1 text-xs text-muted">Vehicles</p></div></div>
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success"><ShieldCheck className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{activePolicies.length}</p><p className="mt-1 text-xs text-muted">Active policies</p></div></div>
        <div className="stat-card"><div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${dueSoon ? 'bg-warning/10 text-warning' : 'bg-elevated text-muted'}`}><CalendarClock className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{dueSoon}</p><p className="mt-1 text-xs text-muted">Renewals due ≤30d</p></div></div>
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><KeyRound className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{activeRental ? 1 : 0}</p><p className="mt-1 text-xs text-muted">Active rental</p></div></div>
      </div>

      {/* Emergency quick-glance: insurance + accident help */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-success" /> Insurance — quick access</h2>
            <Link href="/dashboard/auto/insurance" className="text-xs font-medium text-brand underline">All policies</Link>
          </div>
          {activePolicies.length === 0 ? (
            <p className="text-sm text-muted">No active policy yet. <Link href="/dashboard/auto/insurance" className="text-brand underline">Add one</Link> for instant emergency access.</p>
          ) : (
            <div className="space-y-2">
              {activePolicies.slice(0, 3).map((p) => (
                <div key={p.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{p.provider ?? 'Insurer'}</p>
                    {p.policy_number && <Badge tone="brand">#{p.policy_number}</Badge>}
                  </div>
                  {p.coverage_summary && <p className="mt-1 text-xs text-muted">{p.coverage_summary}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.claims_phone && <a href={`tel:${p.claims_phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-2.5 text-xs font-medium text-white"><Phone className="h-3.5 w-3.5" /> File a claim</a>}
                    {p.roadside_phone && <a href={`tel:${p.roadside_phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated"><Phone className="h-3.5 w-3.5" /> Roadside</a>}
                    {p.agent_phone && <a href={`tel:${p.agent_phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated"><Phone className="h-3.5 w-3.5" /> Agent</a>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-danger" /> In an accident?</h2>
          <p className="mb-3 text-sm text-muted">Stay calm. Get an AI step-by-step for safety, what to document, who to call, and how to start your claim.</p>
          <Link href="/dashboard/auto/accident" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg"><Stethoscope className="h-4 w-4" /> Open Accident Help</Link>
          {activeRental && (
            <div className="mt-3 rounded-xl border border-border p-3">
              <p className="text-xs font-medium text-accent">Active rental</p>
              <p className="text-sm">{activeRental.company ?? 'Rental'} · {activeRental.vehicle_desc ?? '—'}</p>
              {activeRental.confirmation_number && <p className="text-xs text-muted">Conf #{activeRental.confirmation_number}</p>}
            </div>
          )}
        </Card>
      </div>

      {/* Upcoming renewals */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-brand" /> Upcoming renewals</h2>
        </div>
        {renewals.length === 0 ? (
          <p className="text-sm text-muted">No renewal dates on file yet. Add expiry dates to your license, registration, inspection, and insurance to get reminders here.</p>
        ) : (
          <div className="space-y-1.5">
            {renewals.slice(0, 12).map((r) => (
              <Link key={`${r.kind}-${r.id}`} href={r.href} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated/50">
                <span className="min-w-0 flex-1 truncate">{r.label}{r.subject ? ` · ${r.subject}` : ''}</span>
                <span className="shrink-0 text-xs text-muted">{fmtDate(r.expiresOn)}</span>
                <Badge tone={r.status.tone}>{r.status.label}</Badge>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
