import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, XCircle, Server, Plug, ShieldCheck, Database, UsersRound, Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Admin · Settings', robots: { index: false } };
export const dynamic = 'force-dynamic';

function host(url: string | undefined): string {
  if (!url) return '—';
  try { return new URL(url).host; } catch { return url; }
}

export default async function AdminSettingsPage() {
  const supabase = createServiceClient();
  const { count: superAdmins } = await supabase.from('super_admins').select('email', { count: 'exact', head: true });

  const providers = [
    { name: 'Supabase (database, auth, storage)', ready: !!process.env.NEXT_PUBLIC_SUPABASE_URL, detail: host(process.env.NEXT_PUBLIC_SUPABASE_URL) },
    { name: 'Stripe (payments)', ready: !!process.env.STRIPE_SECRET_KEY, detail: 'STRIPE_SECRET_KEY' },
    { name: 'Resend (email)', ready: !!process.env.RESEND_API_KEY, detail: 'RESEND_API_KEY' },
    { name: 'Anthropic (AI)', ready: !!process.env.ANTHROPIC_API_KEY, detail: process.env.AI_MODEL ?? 'ANTHROPIC_API_KEY' },
    { name: 'Google OAuth (sign-in + calendar)', ready: !!process.env.GOOGLE_CLIENT_ID, detail: 'GOOGLE_CLIENT_ID' },
    { name: 'Twilio (SMS)', ready: !!process.env.TWILIO_AUTH_TOKEN, detail: 'TWILIO_AUTH_TOKEN' },
    { name: 'Resend webhook (email tracking)', ready: !!process.env.RESEND_WEBHOOK_SECRET, detail: 'RESEND_WEBHOOK_SECRET' },
    { name: 'Vercel Cron', ready: !!process.env.CRON_SECRET, detail: 'CRON_SECRET' },
    { name: 'Sync token encryption', ready: !!process.env.SYNC_TOKEN_KEY, detail: 'SYNC_TOKEN_KEY' },
  ];

  const system = [
    { label: 'Environment', value: process.env.NODE_ENV ?? 'unknown' },
    { label: 'Supabase project', value: host(process.env.NEXT_PUBLIC_SUPABASE_URL) },
    { label: 'App URL', value: process.env.NEXT_PUBLIC_APP_URL ?? '—' },
    { label: 'Super administrators', value: String(superAdmins ?? 0) },
  ];

  const links = [
    { href: '/admin/ai', label: 'AI Engine', desc: 'Choose Claude or ChatGPT & set API keys', icon: Sparkles },
    { href: '/admin/admins', label: 'Administrators', desc: 'Manage super-admin access', icon: UsersRound },
    { href: '/admin/integrations', label: 'Integrations', desc: 'Connected services & keys', icon: Plug },
    { href: '/admin/security', label: 'Security', desc: 'Access & audit controls', icon: ShieldCheck },
    { href: '/admin/backup', label: 'Data & Storage', desc: 'Row counts, storage, backups', icon: Database },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted">Live system configuration and connected services. Status reflects the real server environment.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-2"><Plug className="h-4 w-4 text-brand" /><h2 className="font-semibold">Connected services</h2></div>
          <ul className="space-y-2">
            {providers.map((p) => (
              <li key={p.name} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate">{p.name}</p>
                  <p className="truncate text-xs text-muted">{p.detail}</p>
                </div>
                {p.ready
                  ? <span className="inline-flex shrink-0 items-center gap-1 text-success"><CheckCircle2 className="h-4 w-4" /> Connected</span>
                  : <span className="inline-flex shrink-0 items-center gap-1 text-muted"><XCircle className="h-4 w-4" /> Not set</span>}
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="mb-4 flex items-center gap-2"><Server className="h-4 w-4 text-brand" /><h2 className="font-semibold">System</h2></div>
            <div className="space-y-2 text-sm">
              {system.map((r) => (
                <div key={r.label} className="flex justify-between gap-3">
                  <span className="text-muted">{r.label}</span>
                  <span className="truncate font-medium">{r.value}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Configuration</h2>
            <div className="space-y-1">
              {links.map((l) => (
                <Link key={l.href} href={l.href} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-elevated">
                  <l.icon className="h-4 w-4 text-muted" />
                  <div className="flex-1">
                    <p className="font-medium">{l.label}</p>
                    <p className="text-xs text-muted">{l.desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
