// lib/marketplace/matches-server.ts — live marketplace match intelligence.
//
// Reads the family's open listings, runs the pure matcher (lib/marketplace/matches.ts),
// writes today's active matches to marketplace_matches (PRESERVING dismissals — a
// match the family waved off stays quiet), and returns the active matches enriched
// with titles + the poster's name for the strip. Best-effort: a drifted DB (table
// not yet applied) just yields no matches rather than throwing.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { computeMatches, type MatchListing, type MarketplaceMatch } from '@/lib/marketplace/matches';
import { KIND_LABELS, type ListingKind } from '@/lib/marketplace/listings';

type DB = SupabaseClient<Database>;

/** A supply kind phrased for the reason line ("listed X for free"). */
const KIND_PHRASE: Record<string, string> = {
  sell: 'for sale', rent: 'to rent', borrow: 'to borrow', free: 'for free',
};

export type EnrichedMatch = {
  id: string;
  wantedId: string;
  supplyId: string;
  supplyKind: string;
  supplyKindLabel: string;
  score: number;
  wantedTitle: string;
  supplyTitle: string;
  supplyMemberName: string | null;
  reason: string;
};

function reasonFor(wantedTitle: string, supplyTitle: string, supplyKind: string, who: string | null): string {
  const phrase = KIND_PHRASE[supplyKind] ?? 'on the board';
  const by = who ? `${who} listed` : 'Someone listed';
  return `You’re looking for “${wantedTitle}” — ${by} “${supplyTitle}” ${phrase}.`;
}

/**
 * Compute + persist the family's marketplace matches and return the active ones.
 * Dismissed/actioned matches are never re-activated; new matches insert as active.
 */
export async function loadAndSnapshotMatches(sb: DB, familyId: string, userId: string | null): Promise<EnrichedMatch[]> {
  try {
    const { data: rows } = await sb
      .from('marketplace_listings')
      .select('id, kind, category, status, title, member_id, price_cents')
      .eq('family_id', familyId)
      .in('status', ['available', 'pending'])
      .limit(2000);

    const listings = (rows ?? []) as MatchListing[];
    const matches = computeMatches(listings);
    if (matches.length === 0) return [];

    const byId = new Map(listings.map((l) => [l.id, l]));

    // Member display names for the reason line (best-effort).
    const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
    const nameOf = new Map((members ?? []).map((m) => [m.id, m.display_name]));

    // Existing rows so we can preserve dismissed/actioned decisions.
    const { data: existing } = await sb
      .from('marketplace_matches')
      .select('id, wanted_id, supply_id, status')
      .eq('family_id', familyId);
    const priorStatus = new Map((existing ?? []).map((e) => [`${e.wanted_id}:${e.supply_id}`, e.status]));

    const build = (m: MarketplaceMatch) => {
      const supply = byId.get(m.supplyId);
      const wanted = byId.get(m.wantedId);
      const who = supply?.member_id ? nameOf.get(supply.member_id) ?? null : null;
      return {
        wanted, supply, who,
        reason: reasonFor(wanted?.title ?? '', supply?.title ?? '', m.supplyKind, who),
      };
    };

    // Upsert only matches that aren't already dismissed/actioned (leave those be).
    const toUpsert = matches
      .filter((m) => {
        const s = priorStatus.get(`${m.wantedId}:${m.supplyId}`);
        return s !== 'dismissed' && s !== 'actioned';
      })
      .map((m) => ({
        family_id: familyId, wanted_id: m.wantedId, supply_id: m.supplyId,
        score: m.score, reason: build(m).reason, status: 'active', created_by: userId,
      }));

    if (toUpsert.length > 0) {
      await sb.from('marketplace_matches').upsert(toUpsert as never, { onConflict: 'family_id,wanted_id,supply_id' });
    }

    // Re-read the active rows (now carrying their real ids) to return to the strip.
    const { data: active } = await sb
      .from('marketplace_matches')
      .select('id, wanted_id, supply_id, score, reason, status')
      .eq('family_id', familyId)
      .eq('status', 'active')
      .order('score', { ascending: false })
      .limit(20);

    return (active ?? []).flatMap((r): EnrichedMatch[] => {
      const supply = byId.get(r.supply_id);
      const wanted = byId.get(r.wanted_id);
      if (!supply || !wanted) return []; // a listing was removed since the snapshot
      const who = supply.member_id ? nameOf.get(supply.member_id) ?? null : null;
      return [{
        id: r.id, wantedId: r.wanted_id, supplyId: r.supply_id,
        supplyKind: supply.kind, supplyKindLabel: KIND_LABELS[supply.kind as ListingKind] ?? supply.kind,
        score: r.score, wantedTitle: wanted.title, supplyTitle: supply.title,
        supplyMemberName: who, reason: r.reason ?? reasonFor(wanted.title, supply.title, supply.kind, who),
      }];
    });
  } catch {
    return []; // table not applied yet / transient error → no strip
  }
}
