'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Loader2, ShieldAlert, CheckCircle2, ExternalLink } from 'lucide-react';
import { PROVIDERS, PLATFORMS, type SocialPlatform } from '@/lib/social/capabilities';
import { connectAccountAction } from '@/app/(app)/dashboard/social/actions';
import { PlatformDot } from './platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** readiness is computed server-side (reads env) and passed in to avoid leaking
 *  which env vars exist; the client only sees ready/requires_setup booleans. */
export function ConnectGrid({ readiness }: { readiness: Record<SocialPlatform, boolean> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyPlatform, setBusyPlatform] = useState<SocialPlatform | null>(null);
  const [message, setMessage] = useState<string>('');

  function connect(platform: SocialPlatform) {
    setBusyPlatform(platform);
    setMessage('');
    const fd = new FormData();
    fd.set('platform', platform);
    start(async () => {
      const r = await connectAccountAction(fd);
      setBusyPlatform(null);
      if (!r.ok) {
        setMessage(r.error ?? 'Could not start connection.');
      } else if (r.requiresSetup) {
        setMessage(`${PROVIDERS[platform].label}: app credentials are not configured, so the account was added in a "requires setup" state. Add credentials to authorize.`);
      } else {
        setMessage(`${PROVIDERS[platform].label}: ready to authorize. Complete the OAuth step to finish connecting.`);
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {message && <Card><p className="text-sm text-muted">{message}</p></Card>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORMS.map((p) => {
          const def = PROVIDERS[p];
          const ready = readiness[p];
          return (
            <Card key={p} className="flex flex-col">
              <div className="mb-2 flex items-center gap-2">
                <PlatformDot platform={p} />
                <span className="text-sm font-semibold">{def.label}</span>
                {ready ? <Badge tone="success" className="ml-auto">Ready</Badge> : <Badge tone="neutral" className="ml-auto">Requires setup</Badge>}
              </div>
              <ul className="mb-2 space-y-0.5 text-xs text-muted">
                <li>Auth: {def.auth}</li>
                <li>Posting: {def.posting.supported ? 'yes' : 'no'}{def.needsAppReview ? ' · app review required' : ''}</li>
                <li>Feed: {def.feed.supported ? 'yes' : 'no'} · Analytics: {def.analytics.supported ? 'yes' : 'no'}</li>
                <li>Char limit: {def.charLimit.toLocaleString()}</li>
              </ul>
              {!ready && (
                <p className="mb-2 inline-flex items-start gap-1 text-[11px] text-warning">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  Set {def.credentialEnv.join(', ')} to enable.
                </p>
              )}
              <div className="mt-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => connect(p)}
                  disabled={pending && busyPlatform === p}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-brand text-sm font-medium text-brand-fg disabled:opacity-60"
                >
                  {pending && busyPlatform === p ? <Loader2 className="h-4 w-4 animate-spin" /> : ready ? <CheckCircle2 className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
                  {ready ? 'Connect' : 'Add (setup)'}
                </button>
                <a href={def.docsUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted" title="API docs">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
