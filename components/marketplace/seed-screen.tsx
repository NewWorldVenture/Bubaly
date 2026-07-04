'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Database, ExternalLink, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MARKETPLACE_SEED_SQL } from '@/lib/marketplace/seed-sql';

// The "add that sql to the screen" surface: shows the paste-ready marketplace
// seed SQL with a one-tap Copy button (built for iPad — no terminal needed).
export function MarketplaceSeedScreen() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(MARKETPLACE_SEED_SQL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard permission: select the text.
      const el = document.getElementById('seed-sql') as HTMLTextAreaElement | null;
      el?.select();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/dashboard/marketplace" className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label="Back to marketplace">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Database className="h-6 w-6 text-brand" /> Seed test data</h1>
          <p className="text-sm text-muted">Fill the Family Marketplace with 500 realistic listings (plus offers) to test every feature.</p>
        </div>
      </div>

      {/* Steps */}
      <ol className="mb-5 space-y-2 text-sm text-fg">
        <li className="flex gap-2"><span className="font-semibold text-brand">1.</span> Open your <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">Supabase dashboard <ExternalLink className="h-3.5 w-3.5" /></a> → <span className="font-medium">SQL Editor</span> → <span className="font-medium">New query</span>.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand">2.</span> Tap <span className="font-medium">Copy SQL</span> below and paste it into the editor.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand">3.</span> Press <span className="font-medium">Run</span>. You&apos;ll see “Marketplace seed complete: 500 listings”.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand">4.</span> Reload the Marketplace — 500 listings across every type and status will be live.</li>
      </ol>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Safe to re-run. It first <strong>clears the chosen family&apos;s existing marketplace rows</strong>, then inserts a fresh 500 — it touches only that one family. To seed a different account, change the <code className="rounded bg-black/30 px-1">v_email</code> value at the top of the script.
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">marketplace_seed.sql</span>
        <Button onClick={copy} size="sm" className="gap-1.5">
          {copied ? <><Check className="h-4 w-4" /> Copied!</> : <><Copy className="h-4 w-4" /> Copy SQL</>}
        </Button>
      </div>

      <textarea
        id="seed-sql"
        readOnly
        value={MARKETPLACE_SEED_SQL}
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
        className="h-[28rem] w-full resize-y rounded-xl border border-border bg-black/40 p-4 font-mono text-xs leading-relaxed text-emerald-100 outline-none focus:border-brand"
      />

      <div className="mt-4 flex justify-end">
        <Button onClick={copy} className="gap-1.5">
          {copied ? <><Check className="h-4 w-4" /> Copied to clipboard</> : <><Copy className="h-4 w-4" /> Copy SQL</>}
        </Button>
      </div>
    </div>
  );
}
