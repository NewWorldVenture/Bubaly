import type { Metadata } from 'next';
import { Users, UserCheck, ClipboardList, Gauge, Flame, ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { buildFunnel, pct, type FunnelCounts } from '@/lib/marketing/visitor-funnel';
import { CONTACT_BAND_META, type ContactBand } from '@/lib/marketing/contact-score';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Visitor Intelligence', robots: { index: false } };
export const dynamic = 'force-dynamic';

type SupabaseAdmin = ReturnType<typeof createServiceClient>;

// Every count is best-effort — a table not applied yet degrades to 0, never a crash.
async function count(admin: SupabaseAdmin, build: (q: SupabaseAdmin) => PromiseLike<{ count: number | null }>): Promise<number> {
  try { const { count: c } = await build(admin); return c ?? 0; } catch { return 0; }
}

export default async function VisitorIntelligencePage() {
  const admin = createServiceClient();

  const [
    visitors, identified, profiled, scored, engaged,
    cold, warm, hot, qualified,
    analyticsGrants, marketingGrants,
  ] = await Promise.all([
    count(admin, (a) => a.from('mkt_visitors').select('*', { count: 'exact', head: true })),
    count(admin, (a) => a.from('mkt_visitors').select('*', { count: 'exact', head: true }).not('contact_id', 'is', null)),
    count(admin, (a) => a.from('crm_contact_profile').select('*', { count: 'exact', head: true })),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true })),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true }).in('band', ['hot', 'qualified'])),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true }).eq('band', 'cold')),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true }).eq('band', 'warm')),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true }).eq('band', 'hot')),
    count(admin, (a) => a.from('crm_lead_scores').select('*', { count: 'exact', head: true }).eq('band', 'qualified')),
    count(admin, (a) => a.from('mkt_consent_events').select('*', { count: 'exact', head: true }).eq('category', 'analytics').eq('decision', 'granted')),
    count(admin, (a) => a.from('mkt_consent_events').select('*', { count: 'exact', head: true }).in('category', ['marketing_email', 'marketing_sms']).eq('decision', 'granted')),
  ]);

  const counts: FunnelCounts = { visitors, identified, profiled, scored, engaged };
  const funnel = buildFunnel(counts);
  const bands: { band: ContactBand; n: number }[] = [
    { band: 'cold', n: cold }, { band: 'warm', n: warm }, { band: 'hot', n: hot }, { band: 'qualified', n: qualified },
  ];
  const bandTotal = cold + warm + hot + qualified;

  const stageIcon: Record<string, typeof Users> = {
    visitors: Users, identified: UserCheck, profiled: ClipboardList, scored: Gauge, engaged: Flame,
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-black sm:text-2xl">Visitor Intelligence</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The privacy-first acquisition funnel end-to-end — anonymous visitors becoming identified,
          profiled, scored, and engaged. All first-party and consent-gated; no fingerprinting.
        </p>
      </header>

      {/* Funnel */}
      <Card className="p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Acquisition funnel</h2>
        <div className="mt-4 space-y-2.5">
          {funnel.map((s) => {
            const Icon = stageIcon[s.key] ?? Users;
            return (
              <div key={s.key} className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-brand-text ring-1 ring-white/10"><Icon className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{s.label}</span>
                    <span className="text-xs text-muted">
                      <span className="font-bold tabular-nums text-fg">{s.count.toLocaleString()}</span>
                      {' · '}{s.pctOfTop}% of visitors{s.key !== 'visitors' && <> · {s.pctOfPrev}% step</>}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand to-violet-500 transition-all" style={{ width: `${Math.max(s.pctOfTop, s.count > 0 ? 1.5 : 0)}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Lead-band distribution */}
        <Card className="p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Lead score bands</h2>
          {bandTotal === 0 ? (
            <p className="mt-3 text-sm text-muted">No scored contacts yet — run Recompute on Lead Scores.</p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {bands.map(({ band, n }) => (
                <div key={band} className="flex items-center gap-3">
                  <span className={cn('w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-bold uppercase tracking-wide', CONTACT_BAND_META[band].tint)}>
                    {CONTACT_BAND_META[band].label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct(n, bandTotal)}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted">{n.toLocaleString()} · {pct(n, bandTotal)}%</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Consent posture */}
        <Card className="p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-muted">
            <ShieldCheck className="h-3.5 w-3.5" /> Consent posture
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-bg/40 p-3">
              <p className="text-2xl font-black tabular-nums">{analyticsGrants.toLocaleString()}</p>
              <p className="text-xs text-muted">Analytics grants</p>
            </div>
            <div className="rounded-xl border border-border bg-bg/40 p-3">
              <p className="text-2xl font-black tabular-nums">{marketingGrants.toLocaleString()}</p>
              <p className="text-xs text-muted">Marketing opt-ins</p>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Consent is append-only and revocable; analytics is legitimate-interest until denied or a
            GPC signal is present, and marketing is strict opt-in. Identity linking carries each
            visitor&apos;s consent forward to their contact.
          </p>
        </Card>
      </div>
    </div>
  );
}
