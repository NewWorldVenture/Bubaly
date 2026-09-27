import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { normalizeHandle } from '@/lib/wallet/pay-handle';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Send a gift · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

// Public Pay-ID resolver: /pay/<handle> → the child's newest active gift link.
// Reads via the service role (the visitor isn't signed in). No money here — it
// just forwards to the existing /gift/<token> flow.
export default async function PayHandlePage({ params }: { params: Promise<{ handle: string }> }) {
  const t = await getTranslations();
  const { handle: raw } = await params;
  const handle = normalizeHandle(raw);
  const supabase = createServiceClient();

  // Both reads below dropped their `error`, and both failure modes landed on the
  // same dead-end as a handle that genuinely has no link. So a refused or failed
  // read told a grandparent standing in a shop that this child's Pay-ID is dead,
  // and the copy sends them to ask the family for a new one — a support ticket
  // and an abandoned gift over what may be a transient fault, with nothing in
  // the page to suggest retrying.
  //
  // Telling the two apart does NOT weaken the privacy property the dead-end
  // exists for. The error shell below is rendered from the read's outcome, never
  // from anything about the handle, so it appears identically for a handle that
  // exists and one that does not — it leaks nothing that "no active link"
  // did not already leak. Audit C1-S9-31.
  const { data: ph, error: phError } = await supabase
    .from('pay_handles')
    .select('family_id, child_wallet_id, is_active')
    .eq('handle', handle)
    .maybeSingle();

  if (phError) return <Unavailable t={t} />;

  if (ph && ph.is_active) {
    // Find the newest active gift link for the target (a child, or any family link).
    let q = supabase
      .from('gift_links')
      .select('token')
      .eq('family_id', ph.family_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    q = ph.child_wallet_id ? q.eq('child_wallet_id', ph.child_wallet_id) : q;
    const { data: link, error: linkError } = await q.maybeSingle();
    if (linkError) return <Unavailable t={t} />;
    if (link?.token) redirect(`/gift/${link.token}`);
  }

  // No handle / no active link → a friendly dead-end (never leaks whether a
  // handle exists beyond "no active link right now").
  return (
    <Shell emoji="🎁" title={t('pay.noActiveGiftLink')} body={t('pay.thisPayIdDoesntHaveAn')} t={t} />
  );
}

type Translate = (key: string) => string;

/** The read did not complete. Deliberately says nothing about the handle. */
function Unavailable({ t }: { t: Translate }) {
  return <Shell emoji="⏳" title={t('pay.couldNotCheckThisPayId')} body={t('pay.pleaseTryAgainInAMoment')} t={t} />;
}

function Shell({ emoji, title, body, t }: { emoji: string; title: string; body: string; t: Translate }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-2xl">{emoji}</div>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-sm text-muted">{body}</p>
      <Link href="/" className="text-sm font-medium text-brand-text hover:underline">{t('pay.goToBubaly')}</Link>
    </div>
  );
}
