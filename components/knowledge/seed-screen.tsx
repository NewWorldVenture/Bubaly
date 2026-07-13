'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Database, ExternalLink, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FAMILY_FACTS_SEED_SQL } from '@/lib/memory/facts-seed-sql';

// Admin "Seed test data" screen for the Family Knowledge Base — shows the
// paste-ready SQL with a one-tap Copy button (iPad-friendly, no terminal).
export function KnowledgeSeedScreen() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(FAMILY_FACTS_SEED_SQL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      (document.getElementById('kb-seed-sql') as HTMLTextAreaElement | null)?.select();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/dashboard/knowledge" className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label="Back to knowledge base">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Database className="h-6 w-6 text-brand-text" /> Seed test data</h1>
          <p className="text-sm text-muted">Populate every family&apos;s Knowledge Base with a realistic starter set of facts.</p>
        </div>
      </div>

      <ol className="mb-5 space-y-2 text-sm text-fg">
        <li className="flex gap-2"><span className="font-semibold text-brand-text">1.</span> Open your <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">Supabase dashboard <ExternalLink className="h-3.5 w-3.5" /></a> → <span className="font-medium">SQL Editor</span> → <span className="font-medium">New query</span>.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand-text">2.</span> Tap <span className="font-medium">Copy SQL</span> below and paste it in.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand-text">3.</span> Press <span className="font-medium">Run</span>. You&apos;ll see “Family Knowledge Base seeded for N families”.</li>
        <li className="flex gap-2"><span className="font-semibold text-brand-text">4.</span> Reload <span className="font-medium">/dashboard/knowledge</span> — facts, sizes, contacts and allergies are live.</li>
      </ol>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Non-destructive: it seeds <strong>only families that have no facts yet</strong>, so any family that has entered real data is left untouched. Re-running is a safe no-op for already-populated families.
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">family_facts_seed.sql</span>
        <Button onClick={copy} size="sm" className="gap-1.5">
          {copied ? <><Check className="h-4 w-4" /> Copied!</> : <><Copy className="h-4 w-4" /> Copy SQL</>}
        </Button>
      </div>

      <textarea
        id="kb-seed-sql"
        readOnly
        value={FAMILY_FACTS_SEED_SQL}
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
