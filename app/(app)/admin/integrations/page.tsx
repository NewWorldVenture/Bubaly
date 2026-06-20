import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Plus, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Cloud,
  CreditCard, Mail, Cpu, Database, Activity, Calendar, ArrowRight, KeyRound,
  Webhook, Settings, HardDrive,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { checkDatabase, checkStorage, checkAuth, checkStripe, checkEmail, checkAI } from '@/lib/server/health';
import { Card } from '@/components/ui/card';
import { BigDonut } from '@/components/admin/charts';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Integrations', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = ['All Integrations', 'Connected', 'Available', 'Authentication', 'Webhooks', 'API Keys'] as const;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

type Status = 'connected' | 'issue' | 'disconnected';
type Integration = {
  key: string; name: string; description: string; category: string;
  icon: React.ComponentType<{ className?: string }>; status: Status; detail: string; lastSync: string | null;
};

type SP = { searchParams: Promise<{ tab?: string }> };

export default async function AdminIntegrationsPage({ searchParams }: SP) {
  const sp = await searchParams;
  const activeTab = TABS.find((t) => slug(t) === sp.tab) ?? 'All Integrations';
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const [db, storage, auth, stripe, email, { count: googleCalCount }] = await Promise.all([
    checkDatabase(supabase), checkStorage(supabase), checkAuth(supabase), checkStripe(),
    Promise.resolve(checkEmail()),
    supabase.from('user_preferences').select('user_id', { count: 'exact', head: true }).not('notification_prefs->googleCalendarToken', 'is', null),
  ]);
  const ai = checkAI();
  const st = (ok: boolean, configured = true): Status => (ok ? 'connected' : configured ? 'issue' : 'disconnected');

  // Real registry: status from live probes + configuration.
  const all: Integration[] = [
    { key: 'db', name: 'Supabase Database', description: 'Primary Postgres database', category: 'Database', icon: Database, status: st(db.ok), detail: db.ok ? `Healthy · ${db.latencyMs}ms` : db.detail, lastSync: now },
    { key: 'storage', name: 'Supabase Storage', description: 'Document & media storage', category: 'Cloud Storage', icon: HardDrive, status: st(storage.ok), detail: storage.ok ? `Healthy · ${storage.latencyMs}ms` : storage.detail, lastSync: now },
    { key: 'auth', name: 'Supabase Auth', description: 'Authentication & sessions', category: 'Authentication', icon: KeyRound, status: st(auth.ok), detail: auth.ok ? `Healthy · ${auth.latencyMs}ms` : auth.detail, lastSync: now },
    { key: 'stripe', name: 'Stripe', description: 'Payment processing and billing', category: 'Payments', icon: CreditCard, status: st(stripe.ok, !!process.env.STRIPE_SECRET_KEY), detail: stripe.ok ? `Live · ${stripe.latencyMs}ms` : stripe.detail, lastSync: stripe.ok ? now : null },
    { key: 'resend', name: 'Resend', description: 'Transactional email delivery', category: 'Communication', icon: Mail, status: st(email.ok, !!process.env.RESEND_API_KEY), detail: email.detail, lastSync: email.ok ? now : null },
    { key: 'anthropic', name: 'Anthropic', description: 'AI assistant and automation', category: 'AI', icon: Cpu, status: st(ai.ok, !!process.env.ANTHROPIC_API_KEY), detail: ai.detail, lastSync: ai.ok ? now : null },
    { key: 'google', name: 'Google Calendar', description: 'Calendar sync for members', category: 'Productivity', icon: Calendar, status: (googleCalCount ?? 0) > 0 ? 'connected' : (process.env.GOOGLE_CLIENT_ID ? 'issue' : 'disconnected'), detail: `${googleCalCount ?? 0} member${googleCalCount === 1 ? '' : 's'} connected`, lastSync: (googleCalCount ?? 0) > 0 ? now : null },
    { key: 'vercel', name: 'Vercel', description: 'Hosting and edge delivery', category: 'Monitoring', icon: Cloud, status: process.env.VERCEL ? 'connected' : 'disconnected', detail: process.env.VERCEL ? `Region ${process.env.VERCEL_REGION ?? '—'}` : 'Local environment', lastSync: process.env.VERCEL ? now : null },
  ];

  const connected = all.filter((i) => i.status === 'connected');
  const issues = all.filter((i) => i.status === 'issue');
  const disconnected = all.filter((i) => i.status === 'disconnected');
  const filtered = activeTab === 'Connected' ? connected : activeTab === 'Available' ? disconnected : all;

  const categories = new Map<string, number>();
  for (const i of all) categories.set(i.category, (categories.get(i.category) ?? 0) + 1);
  const topCategories = [...categories.entries()].sort((a, b) => b[1] - a[1]);

  const META: Record<Status, { label: string; tone: string; dot: string }> = {
    connected: { label: 'Connected', tone: 'text-emerald-400', dot: 'bg-emerald-400' },
    issue: { label: 'Connection Issue', tone: 'text-amber-400', dot: 'bg-amber-400' },
    disconnected: { label: 'Disconnected', tone: 'text-muted', dot: 'bg-white/30' },
  };
  const showInfoTab = ['Authentication', 'Webhooks', 'API Keys'].includes(activeTab) && activeTab !== 'Authentication';
  const env = process.env;

  return (
    <div className="module-page space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Integrations</h1>
          <p className="mt-1 text-sm text-muted">Connect and manage third-party services and integrations.</p>
        </div>
        <Link href="/admin/settings" className="btn-cta"><Plus className="h-4 w-4" /> Add Integration</Link>
      </div>

      <div className="tab-bar border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/integrations?tab=${slug(t)}`} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', activeTab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>{t}</Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {!showInfoTab ? (
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold">{activeTab}</h2>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted"><RefreshCw className="h-3.5 w-3.5" /> Live status</span>
              </div>
              <div className="table-responsive">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted">
                    <th className="pb-2 pr-3 font-medium">Integration</th><th className="pb-2 pr-3 font-medium">Category</th>
                    <th className="pb-2 pr-3 font-medium">Status</th><th className="pb-2 font-medium">Last Sync</th>
                  </tr></thead>
                  <tbody>
                    {filtered.map((i) => {
                      const m = META[i.status];
                      return (
                        <tr key={i.key} className="border-b border-border/50 last:border-0">
                          <td className="py-3 pr-3">
                            <span className="flex items-center gap-3">
                              <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface text-muted"><i.icon className="h-5 w-5" /></span>
                              <span><span className="block font-medium">{i.name}</span><span className="block text-xs text-muted">{i.description}</span></span>
                            </span>
                          </td>
                          <td className="py-3 pr-3"><span className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-muted">{i.category}</span></td>
                          <td className="py-3 pr-3"><span className={cn('flex items-center gap-1.5 text-xs font-medium', m.tone)}><span className={cn('h-2 w-2 rounded-full', m.dot)} />{m.label}</span><span className="block text-[11px] text-muted">{i.detail}</span></td>
                          <td className="py-3 text-xs text-muted">{i.lastSync ? fmtDate(i.lastSync, 'MMM d, h:mm a') : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">Showing {filtered.length} of {all.length} integrations · status from live health probes.</p>
            </Card>
          ) : (
            <Card>
              <h2 className="mb-2 text-base font-semibold">{activeTab}</h2>
              {activeTab === 'API Keys' && (
                <ul className="space-y-2">
                  {[
                    { label: 'Supabase anon key', set: !!env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
                    { label: 'Supabase service role key', set: !!env.SUPABASE_SERVICE_ROLE_KEY },
                    { label: 'Stripe secret key', set: !!env.STRIPE_SECRET_KEY },
                    { label: 'Resend API key', set: !!env.RESEND_API_KEY },
                    { label: 'Anthropic API key', set: !!env.ANTHROPIC_API_KEY },
                  ].map((k) => (
                    <li key={k.label} className="flex items-center justify-between rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                      <span className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted" />{k.label}</span>
                      <span className={cn('text-xs font-medium', k.set ? 'text-emerald-400' : 'text-amber-400')}>{k.set ? 'Configured' : 'Missing'}</span>
                    </li>
                  ))}
                </ul>
              )}
              {activeTab === 'Webhooks' && (
                <div className="flex items-center justify-between rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2"><Webhook className="h-4 w-4 text-muted" /><span className="font-mono text-xs">/api/webhooks/stripe</span></span>
                  <span className={cn('text-xs font-medium', env.STRIPE_WEBHOOK_SECRET ? 'text-emerald-400' : 'text-amber-400')}>{env.STRIPE_WEBHOOK_SECRET ? 'Secured' : 'No secret set'}</span>
                </div>
              )}
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <h2 className="mb-3 text-base font-semibold">Connected Services</h2>
              <ul className="space-y-2">
                {connected.slice(0, 5).map((i) => (
                  <li key={i.key} className="flex items-center gap-3 text-sm">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-surface text-muted"><i.icon className="h-4 w-4" /></span>
                    <span className="flex-1 font-medium">{i.name}</span>
                    <span className="text-xs font-medium text-emerald-400">Connected</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">Developer Resources</h2>
              <ul className="space-y-2 text-sm">
                <li><Link href="/admin/integrations?tab=api-keys" className="flex items-center justify-between rounded-lg px-1 py-1.5 hover:bg-elevated"><span className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted" /> API Keys</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
                <li><Link href="/admin/integrations?tab=webhooks" className="flex items-center justify-between rounded-lg px-1 py-1.5 hover:bg-elevated"><span className="flex items-center gap-2"><Webhook className="h-4 w-4 text-muted" /> Webhooks</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
              </ul>
            </Card>
          </div>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-base font-semibold">Integrations Overview</h2>
            <div className="flex items-center gap-3">
              <BigDonut segments={[{ value: connected.length, color: '#22c55e' }, { value: issues.length, color: '#f59e0b' }, { value: disconnected.length, color: '#64748b' }]} centerTop={String(all.length)} centerBottom="Total" size={130} />
              <ul className="flex-1 space-y-1.5 text-xs">
                <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /><span className="text-muted">Connected</span><span className="ml-auto font-semibold">{connected.length} ({Math.round((connected.length / all.length) * 100)}%)</span></li>
                <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /><span className="text-muted">Connection Issue</span><span className="ml-auto font-semibold">{issues.length}</span></li>
                <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white/30" /><span className="text-muted">Disconnected</span><span className="ml-auto font-semibold">{disconnected.length}</span></li>
              </ul>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Integration Health</h2>
            <ul className="space-y-3 text-sm">
              {[
                { label: 'Healthy', value: connected.length, color: 'bg-emerald-400', icon: CheckCircle2, tone: 'text-emerald-400' },
                { label: 'Issues', value: issues.length, color: 'bg-amber-400', icon: AlertTriangle, tone: 'text-amber-400' },
                { label: 'Disconnected', value: disconnected.length, color: 'bg-white/30', icon: XCircle, tone: 'text-muted' },
              ].map((r) => (
                <li key={r.label} className="flex items-center gap-3">
                  <r.icon className={cn('h-4 w-4', r.tone)} /><span className="flex-1">{r.label}</span>
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/5"><div className={cn('h-full rounded-full', r.color)} style={{ width: `${all.length ? (r.value / all.length) * 100 : 0}%` }} /></div>
                  <span className="w-4 text-right font-semibold">{r.value}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Top Categories</h2>
            <ul className="space-y-2 text-sm">
              {topCategories.map(([cat, count]) => (
                <li key={cat} className="flex items-center gap-2"><Activity className="h-4 w-4 text-muted" /><span className="flex-1">{cat}</span><span className="font-semibold">{count}</span></li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
            <ul className="space-y-1">
              {[
                { icon: Plus, label: 'Add New Integration', href: '/admin/settings' },
                { icon: KeyRound, label: 'Manage API Keys', href: '/admin/integrations?tab=api-keys' },
                { icon: Webhook, label: 'View Webhooks', href: '/admin/integrations?tab=webhooks' },
                { icon: Settings, label: 'Integration Settings', href: '/admin/settings' },
              ].map((a) => (
                <li key={a.label}><Link href={a.href} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-elevated"><a.icon className="h-4 w-4 text-brand" /><span className="flex-1">{a.label}</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
