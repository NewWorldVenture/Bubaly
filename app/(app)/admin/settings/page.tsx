import type { Metadata } from 'next';
import Link from 'next/link';
import { getAdminSettings } from './actions';
import { SettingsForm } from '@/components/admin/settings-form';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = ['General', 'System Configuration', 'User Management', 'Notifications', 'Email Templates', 'Localization', 'Privacy', 'Advanced'] as const;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

type SP = { searchParams: Promise<{ tab?: string }> };

export default async function AdminSettingsPage({ searchParams }: SP) {
  const sp = await searchParams;
  const activeTab = TABS.find((t) => slug(t) === sp.tab) ?? 'General';
  const settings = await getAdminSettings();

  // Real system + environment information.
  const systemInfo = {
    version: `v${process.env.npm_package_version ?? '0.1.0'}`,
    environment: ((process.env.VERCEL_ENV ?? process.env.NODE_ENV) === 'production' ? 'Production' : (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development')).replace(/^\w/, (c) => c.toUpperCase()),
    region: process.env.VERCEL_REGION ?? process.env.FLY_REGION ?? 'local',
    lastUpdated: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
  };

  // Real integration readiness derived from configured env.
  const ok = (v: boolean) => (v ? { tone: 'text-emerald-400' } : { tone: 'text-amber-400' });
  const integrations = [
    { label: 'Payment Gateway', status: process.env.STRIPE_SECRET_KEY ? 'Stripe (Active)' : 'Not configured', ...ok(!!process.env.STRIPE_SECRET_KEY) },
    { label: 'Email Service', status: process.env.RESEND_API_KEY ? 'Resend (Active)' : 'Not configured', ...ok(!!process.env.RESEND_API_KEY) },
    { label: 'Cloud Storage', status: process.env.NEXT_PUBLIC_SUPABASE_URL ? 'Supabase (Active)' : 'Not configured', ...ok(!!process.env.NEXT_PUBLIC_SUPABASE_URL) },
    { label: 'AI Services', status: process.env.ANTHROPIC_API_KEY ? 'Anthropic (Active)' : 'Not configured', ...ok(!!process.env.ANTHROPIC_API_KEY) },
  ];

  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage system preferences and configuration settings.</p>
      </div>

      <div className="tab-bar border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/settings?tab=${slug(t)}`} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', activeTab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>{t}</Link>
        ))}
      </div>

      <SettingsForm initial={settings} tab={slug(activeTab)} systemInfo={systemInfo} integrations={integrations} />

      <p className="text-center text-xs text-muted">Changes made to settings may take a few minutes to apply across the system.</p>
    </div>
  );
}
