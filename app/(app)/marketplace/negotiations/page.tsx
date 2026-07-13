import type { Metadata } from 'next';
import Link from 'next/link';
import { Handshake, ArrowRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { whoseTurn, statusLine, type Party, type NegotiationStatus } from '@/lib/marketplace/negotiation';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Offers · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

type Row = {
  id: string; listing_id: string; family_id: string; buyer_member_id: string; buyer_family_id: string;
  status: string; current_amount_cents: number; last_actor: string; agreed_amount_cents: number | null; updated_at: string;
};

/** The negotiation inbox — every "Make an Offer" thread you're part of, split by
 *  whose move it is. The full thread + accept/counter lives on the item page. */
export default async function NegotiationsInboxPage() {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;

  const { data: negRows } = await sb
    .from('marketplace_negotiations')
    .select('id, listing_id, family_id, buyer_member_id, buyer_family_id, status, current_amount_cents, last_actor, agreed_amount_cents, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100);

  const rows = (negRows ?? []) as Row[];
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const { data: listings } = listingIds.length
    ? await sb.from('marketplace_listings').select('id, title, member_id, price_cents').in('id', listingIds)
    : { data: [] };
  const listingMap = new Map((listings ?? []).map((l) => [l.id, l]));
  const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  const nameOf = (id: string | null) => members?.find((m) => m.id === id)?.display_name ?? 'A neighbor';

  // Keep only threads where I'm the buyer or the listing owner (seller).
  type Item = { row: Row; title: string; role: Party; counterparty: string; ask: number };
  const items: Item[] = [];
  for (const row of rows) {
    const l = listingMap.get(row.listing_id);
    if (!l) continue;
    const iAmBuyer = row.buyer_member_id === selfId;
    const iAmSeller = l.member_id === selfId;
    if (!iAmBuyer && !iAmSeller) continue;
    const role: Party = iAmBuyer ? 'buyer' : 'seller';
    items.push({
      row, title: l.title, role, ask: l.price_cents,
      counterparty: role === 'buyer' ? nameOf(l.member_id) : nameOf(row.buyer_member_id),
    });
  }

  const neg = (r: Row) => ({ status: r.status as NegotiationStatus, currentAmountCents: r.current_amount_cents, lastActor: r.last_actor as Party, agreedAmountCents: r.agreed_amount_cents });
  const yourMove = items.filter((i) => i.row.status === 'open' && whoseTurn(neg(i.row)) === i.role);
  const waiting  = items.filter((i) => i.row.status === 'open' && whoseTurn(neg(i.row)) !== i.role);
  const settled  = items.filter((i) => i.row.status !== 'open');

  const Section = ({ title, tone, list }: { title: string; tone: string; list: Item[] }) =>
    list.length === 0 ? null : (
      <section className="mb-6">
        <h2 className={cn('mb-2 text-xs font-bold uppercase tracking-wide', tone)}>{title} · {list.length}</h2>
        <ul className="space-y-2">
          {list.map(({ row, title: t, role, counterparty, ask }) => (
            <li key={row.id}>
              <Link href={`/marketplace/item/${row.listing_id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 p-3.5 transition hover:border-brand/40">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {role === 'buyer' ? `Your offer to ${counterparty}` : `${counterparty} offered`} · asking {money(ask)}
                  </p>
                  <p className="mt-0.5 text-xs">{statusLine(neg(row), role)}</p>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold tabular-nums text-brand-text">{money(row.agreed_amount_cents ?? row.current_amount_cents)}</div>
                  <ArrowRight className="ml-auto mt-1 h-4 w-4 text-muted" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="module-page">
      <PageHeader title="Offers" description="Every Make-an-Offer negotiation you’re part of — counter, accept, or decline from the listing." />
      {items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center">
          <Handshake className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-3 text-sm font-semibold">No offers going yet</p>
          <p className="mt-1 text-sm text-muted">Make an offer on a listing, or wait for a buyer to make one on yours — the back-and-forth shows up here.</p>
          <Link href="/marketplace/browse?kind=sell" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90">
            Browse things for sale
          </Link>
        </div>
      ) : (
        <>
          <Section title="Your move" tone="text-brand-text" list={yourMove} />
          <Section title="Waiting on them" tone="text-muted" list={waiting} />
          <Section title="Settled" tone="text-muted" list={settled} />
        </>
      )}
    </div>
  );
}
