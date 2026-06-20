import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, XCircle, ArrowLeft, ExternalLink } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CAPABILITIES, PROVIDER_LABELS, type SyncProvider, type SyncItemKind,
} from '@/lib/sync/capabilities';

export const metadata: Metadata = { title: 'Sync provider' };
export const dynamic = 'force-dynamic';

const VALID: SyncProvider[] = ['google', 'microsoft', 'apple', 'amazon'];
const KINDS: { key: SyncItemKind; label: string }[] = [
  { key: 'calendar', label: 'Calendars' },
  { key: 'reminder', label: 'Reminders' },
  { key: 'note', label: 'Notes' },
];

// Honest, provider-specific setup guidance. No fabricated "click to connect" for
// flows that require credentials/registration we don't yet have wired.
const SETUP: Record<SyncProvider, { steps: string[]; connectHref?: string; docsHref: string; authKind: string }> = {
  google: {
    authKind: 'OAuth 2.0',
    connectHref: '/api/google/calendar/auth',
    docsHref: 'https://developers.google.com/calendar',
    steps: [
      'Click Connect Google to grant calendar (and Tasks) access via OAuth.',
      'Choose which calendars to import and set the sync direction.',
      'Notes: Google Keep has no public API — notes stay internal or export to a Google Doc.',
    ],
  },
  microsoft: {
    authKind: 'OAuth 2.0 (Microsoft Graph)',
    docsHref: 'https://learn.microsoft.com/graph/api/resources/calendar',
    steps: [
      'Connect your Microsoft account to grant Calendars, Tasks (To Do), and OneNote access.',
      'Outlook Calendar, Microsoft To Do, and OneNote all support full two-way sync with delta queries.',
      'Requires the Microsoft Graph app credentials to be configured by an admin.',
    ],
  },
  apple: {
    authKind: 'CalDAV (app-specific password)',
    docsHref: 'https://support.apple.com/en-us/HT204397',
    steps: [
      'Create an app-specific password at appleid.apple.com → Sign-In and Security.',
      'Enter it here to enable CalDAV sync for Apple Calendar and Reminders.',
      'You can also publish a public ICS feed that Apple Calendar subscribes to.',
      'Apple Notes has no public API — notes stay internal to theagoras.',
    ],
  },
  amazon: {
    authKind: 'ICS feed + Alexa account linking',
    docsHref: 'https://developer.amazon.com/docs/alexa/account-linking/account-linking-concepts.html',
    steps: [
      'Publish a theagoras calendar as an ICS feed and add it as an Alexa calendar (one-way to Alexa).',
      'There is no public API to read an Amazon calendar back into theagoras.',
      'Alexa reminder writes require a custom Alexa Skill with account linking (not yet enabled).',
    ],
  },
  internal: { authKind: 'native', docsHref: '#', steps: [] },
};

export default async function SyncProviderPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await params;
  const provider = raw as SyncProvider;
  if (!VALID.includes(provider)) notFound();

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: account } = await supabase
    .from('sync_accounts')
    .select('id, display_name, external_id, sync_status, last_synced_at')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .maybeSingle();

  const setup = SETUP[provider];
  const caps = CAPABILITIES[provider];

  return (
    <div className="module-page">
      <Link href="/dashboard/sync/accounts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> All accounts
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{PROVIDER_LABELS[provider]}</h1>
          <p className="mt-1 text-sm text-muted">Auth: {setup.authKind}</p>
        </div>
        {account ? <Badge tone="success">Connected · {account.sync_status}</Badge> : <Badge tone="neutral">Not connected</Badge>}
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">Capabilities</h2>
        <div className="space-y-2">
          {KINDS.map(({ key, label }) => {
            const c = caps[key];
            const ok = c.read || c.write;
            return (
              <div key={key} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{label}</p>
                    {c.read && c.write && <Badge tone="success">Two-way</Badge>}
                    {c.write && !c.read && <Badge tone="accent">Export only</Badge>}
                    {c.read && !c.write && <Badge tone="brand">Import only</Badge>}
                    {!c.read && !c.write && <Badge tone="neutral">Not supported</Badge>}
                  </div>
                  {c.limitation && <p className="mt-0.5 text-xs text-muted">{c.limitation}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-semibold">Setup</h2>
        <ol className="space-y-2">
          {setup.steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-semibold text-brand">{i + 1}</span>
              <span className="text-muted">{step}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          {setup.connectHref && (
            <Link href={setup.connectHref} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg shadow-glow transition hover:opacity-90">
              Connect {PROVIDER_LABELS[provider]}
            </Link>
          )}
          <a href={setup.docsHref} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium transition hover:bg-elevated">
            Provider docs <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </Card>
    </div>
  );
}
