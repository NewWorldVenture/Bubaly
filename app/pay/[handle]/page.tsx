import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { normalizeHandle } from '@/lib/wallet/pay-handle';

export const metadata: Metadata = { title: 'Send a gift · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

// Public Pay-ID resolver: /pay/<handle> → the child's newest active gift link.
// Reads via the service role (the visitor isn't signed in). No money here — it
// just forwards to the existing /gift/<token> flow.
export default async function PayHandlePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = normalizeHandle(raw);
  const supabase = createServiceClient();

  const { data: ph } = await supabase
    .from('pay_handles')
    .select('family_id, child_wallet_id, is_active')
    .eq('handle', handle)
    .maybeSingle();

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
    const { data: link } = await q.maybeSingle();
    if (link?.token) redirect(`/gift/${link.token}`);
  }

  // No handle / no active link → a friendly dead-end (never leaks whether a
  // handle exists beyond "no active link right now").
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-2xl">🎁</div>
      <h1 className="text-2xl font-bold">No active gift link</h1>
      <p className="text-sm text-muted">
        This Pay-ID doesn’t have an active gift link right now. Please ask the family for a current link.
      </p>
      <Link href="/" className="text-sm font-medium text-brand hover:underline">Go to Bubaly</Link>
    </div>
  );
}
