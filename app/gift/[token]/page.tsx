import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { occasionLabel, DEFAULT_SUGGESTED_CENTS } from '@/lib/wallet/gift';
import { PublicGiftForm } from '@/components/wallet/public-gift-form';

export const metadata: Metadata = { title: 'Send a gift · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function PublicGiftPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = createServiceClient();

  const { data: link } = await supabase
    .from('gift_links')
    .select('id, is_active, occasion, message, suggested_cents, child_wallet_id, family_id')
    .eq('token', token)
    .maybeSingle();

  let childName = 'a child';
  let familyName = 'a family';
  if (link?.child_wallet_id) {
    const { data: cw } = await supabase.from('child_wallets').select('member_id').eq('id', link.child_wallet_id).maybeSingle();
    if (cw?.member_id) {
      const { data: m } = await supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle();
      if (m?.display_name) childName = m.display_name;
    }
  }
  if (link?.family_id) {
    const { data: fam } = await supabase.from('families').select('name').eq('id', link.family_id).maybeSingle();
    if (fam?.name) familyName = fam.name;
  }

  const active = !!link && link.is_active;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-2xl">🎁</div>
        <h1 className="text-2xl font-bold">Send a gift to {childName}</h1>
        <p className="mt-1 text-sm text-muted">{occasionLabel(link?.occasion ?? null)} · {familyName}</p>
        {link?.message && <p className="mt-3 rounded-xl bg-surface/60 p-3 text-sm italic text-muted">“{link.message}”</p>}
      </div>

      {active ? (
        <PublicGiftForm
          token={token}
          suggestedCents={(link!.suggested_cents && link!.suggested_cents.length > 0) ? link!.suggested_cents : DEFAULT_SUGGESTED_CENTS}
          childName={childName}
        />
      ) : (
        <p className="rounded-2xl border border-border bg-surface/40 p-6 text-center text-sm text-muted">
          This gift link is no longer active. Please ask the family for a new one.
        </p>
      )}

      <p className="max-w-xs text-center text-[11px] text-muted">
        Bubaly is not a bank. Your gift is added to a parent-managed wallet after the family approves it.
        No fees are charged until you confirm a payment.
      </p>
    </div>
  );
}
