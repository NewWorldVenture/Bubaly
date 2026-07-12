// lib/marketplace/assistant.ts — the real marketplace assistant brain (pure,
// tested). Backlog #11: the rail panel used to prompt-route to the generic
// assistant; this gives the marketplace its OWN specialist that answers from
// the family's LIVE market data — listings, offers, comparable prices, demand.
//
// Two tiers share this module:
//   1. No LLM key (default): `answerMarketQuestion` routes the intent and
//      composes a grounded, deterministic reply with deep links.
//   2. LLM key configured: the server wraps the same snapshot into
//      `marketSystemPrompt` so the model answers with REAL numbers — and any
//      model failure falls back to tier 1. The contract never changes.

import { extractPriceCents, suggestPriceCents, draftListing, type Comparable } from './quick-post';
import { CATEGORY_LABELS, KIND_LABELS, priceLabel, type ListingCategory, type ListingCondition, type ListingKind, type RentPeriod } from './listings';

export interface SnapshotListing {
  id: string;
  title: string;
  kind: string;
  category: string;
  condition: string | null;
  price_cents: number | null;
  rent_period?: string | null;
  status: string;
  member_id: string | null;
}

export interface SnapshotOffer {
  listing_id: string;
  status: string;
  member_id: string | null;
}

export interface MarketSnapshot {
  listings: SnapshotListing[];
  offers: SnapshotOffer[];
  /** The asker's family_members.id — powers "how are MY listings doing". */
  selfMemberId: string | null;
}

export type MarketIntent = 'price' | 'find' | 'mine' | 'demand' | 'sell' | 'fees' | 'safety' | 'general';

export interface AssistantLink { href: string; label: string }

export interface AssistantReply {
  intent: MarketIntent;
  reply: string;
  links: AssistantLink[];
}

// ── Intent routing ───────────────────────────────────────────────────────────

const INTENT_RULES: [MarketIntent, RegExp][] = [
  ['price', /\b(what should i (charge|ask)|how much (is|should|can|would)|price|worth|charge for|value)\b/i],
  ['mine', /\b(my listings?|my items?|my offers?|my store|how am i doing|any (offers|interest)|did anyone)\b/i],
  ['demand', /\b(in demand|demand|what('s| is) (hot|popular|selling)|what do people (want|need)|wanted)\b/i],
  ['fees', /\b(fees?|commission|cut|charge to sell|cost to (sell|post)|take a percentage)\b/i],
  ['safety', /\b(safe|safety|scam|trust|meet ?up|secure|verified)\b/i],
  ['sell', /\b(how (do|can) i (sell|post|list)|sell (something|an item)|post (something|an item)|list (something|an item)|get rid of)\b/i],
  ['find', /\b(find|looking for|search|any(one| one)? (selling|have)|need a|show me|browse|under \$)\b/i],
];

export function routeMarketIntent(question: string): MarketIntent {
  for (const [intent, rx] of INTENT_RULES) {
    if (rx.test(question)) return intent;
  }
  return 'general';
}

// ── Grounded answer composition ──────────────────────────────────────────────

const STOPWORDS = new Set([
  'find', 'looking', 'for', 'a', 'an', 'the', 'any', 'anyone', 'selling', 'have',
  'need', 'show', 'me', 'under', 'over', 'around', 'about', 'i', 'is', 'my',
  'what', 'whats', 'how', 'much', 'should', 'charge', 'price', 'worth', 'to',
  'in', 'on', 'of', 'do', 'can', 'we', 'you', 'kids', 'good', 'some',
]);

/** Meaningful search terms from a question (price/stopwords removed). */
export function searchTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/\$\s?\d+(?:\.\d{1,2})?/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

function listingLine(l: SnapshotListing): string {
  const price = priceLabel(l.kind as ListingKind, l.price_cents ?? 0, (l.rent_period ?? null) as RentPeriod | null);
  return `“${l.title}” (${KIND_LABELS[l.kind as ListingKind] ?? l.kind}${price ? ` · ${price}` : ''})`;
}

/**
 * Answer a marketplace question from the live snapshot — deterministic,
 * grounded, always with somewhere to go next.
 */
export function answerMarketQuestion(question: string, snapshot: MarketSnapshot): AssistantReply {
  const intent = routeMarketIntent(question);
  const { listings, offers, selfMemberId } = snapshot;
  const available = listings.filter((l) => l.status === 'available');

  if (intent === 'price') {
    // Borrow the quick-post extractor for category/condition detection.
    const draft = draftListing(question);
    const comps: Comparable[] = listings.map((l) => ({
      category: l.category, condition: l.condition, price_cents: l.price_cents, kind: l.kind,
    }));
    const suggestion = suggestPriceCents(draft.category, draft.condition, comps);
    const compCount = comps.filter((c) => c.category === draft.category && c.kind === 'sell' && (c.price_cents ?? 0) > 0).length;
    const catLabel = CATEGORY_LABELS[draft.category as ListingCategory] ?? draft.category;
    if (suggestion != null) {
      return {
        intent,
        reply: `Based on ${compCount} comparable ${catLabel.toLowerCase()} listings on your family board, I'd ask around ${dollars(suggestion)}${draft.condition ? ` for one in ${draft.condition.replace('_', ' ')} condition` : ''}. Post it in one sentence and I'll draft the listing for you.`,
        links: [{ href: '/marketplace', label: '⚡ Post in 60 seconds' }, { href: '/marketplace/insights', label: 'See price benchmarks' }],
      };
    }
    return {
      intent,
      reply: `There aren't enough comparable ${catLabel.toLowerCase()} listings on your board yet for a confident number. Check the market pulse for benchmarks, or post it and see what offers come in.`,
      links: [{ href: '/marketplace/insights', label: 'Market pulse' }, { href: '/marketplace', label: '⚡ Post in 60 seconds' }],
    };
  }

  if (intent === 'find') {
    const terms = searchTerms(question);
    const budget = extractPriceCents(question);
    const hits = available.filter((l) => {
      const hay = `${l.title} ${l.category}`.toLowerCase();
      const termHit = terms.length === 0 || terms.some((t) => hay.includes(t));
      const priceOk = budget == null || (l.price_cents ?? 0) <= budget;
      return termHit && priceOk;
    }).slice(0, 3);
    if (hits.length > 0) {
      return {
        intent,
        reply: `Found ${hits.length === 1 ? 'one' : hits.length} on the board: ${hits.map(listingLine).join('; ')}.`,
        links: hits.map((l) => ({ href: `/marketplace/item/${l.id}`, label: l.title.slice(0, 32) })),
      };
    }
    return {
      intent,
      reply: `Nothing on the board matches that right now. Save it as an alert and Bubaly will ping you the moment a match is posted.`,
      links: [{ href: '/marketplace/alerts', label: 'Save a search alert' }, { href: '/marketplace/browse', label: 'Browse everything' }],
    };
  }

  if (intent === 'mine') {
    if (!selfMemberId) {
      return { intent, reply: 'Once you post a listing I can track its saves and offers for you here.', links: [{ href: '/marketplace', label: '⚡ Post in 60 seconds' }] };
    }
    const mine = listings.filter((l) => l.member_id === selfMemberId && l.status !== 'withdrawn');
    const myIds = new Set(mine.map((l) => l.id));
    const openOffers = offers.filter((o) => myIds.has(o.listing_id) && o.status === 'open');
    if (mine.length === 0) {
      return { intent, reply: `You have nothing listed right now — the fastest way in is one sentence and I'll draft the rest.`, links: [{ href: '/marketplace', label: '⚡ Post in 60 seconds' }] };
    }
    return {
      intent,
      reply: `You have ${mine.length} listing${mine.length === 1 ? '' : 's'} up${openOffers.length > 0 ? ` and ${openOffers.length} open offer${openOffers.length === 1 ? '' : 's'} waiting on you` : ' — no open offers yet'}.`,
      links: [{ href: '/marketplace/store', label: 'Your store' }, ...(openOffers.length > 0 ? [{ href: '/marketplace/store', label: 'Review offers' }] : [])],
    };
  }

  if (intent === 'demand') {
    const wanted = available.filter((l) => l.kind === 'wanted');
    const byCat = new Map<string, number>();
    for (const w of wanted) byCat.set(w.category, (byCat.get(w.category) ?? 0) + 1);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length > 0) {
      const cats = top.map(([c, n]) => `${CATEGORY_LABELS[c as ListingCategory] ?? c} (${n} request${n === 1 ? '' : 's'})`).join(', ');
      return {
        intent,
        reply: `Right now demand is strongest in ${cats}. If you have any of those gathering dust, they'll move fast.`,
        links: [{ href: '/marketplace/browse?kind=wanted', label: 'See all requests' }, { href: '/marketplace/insights', label: 'Market pulse' }],
      };
    }
    return { intent, reply: 'No open requests on the board right now — check the market pulse for what gets saved and offered on most.', links: [{ href: '/marketplace/insights', label: 'Market pulse' }] };
  }

  if (intent === 'fees') {
    return {
      intent,
      reply: 'Family marketplace sales carry no commission — the buyer pays the sale price and the seller keeps all of it. (A small platform service fee applies only if your admin has enabled it, and it is always shown on the order before anyone pays.)',
      links: [{ href: '/marketplace/orders', label: 'Your orders' }],
    };
  }

  if (intent === 'safety') {
    return {
      intent,
      reply: 'Everything here stays inside your trusted family circle: members are verified, both sides review each other after an order, and Trust Scores build with completed hand-offs. Agree on a pickup spot in the listing chat and you are set.',
      links: [{ href: '/marketplace/reviews', label: 'Reviews' }, { href: '/marketplace/creators', label: 'Trusted creators' }],
    };
  }

  if (intent === 'sell') {
    return {
      intent,
      reply: 'Type one sentence — what it is, condition, price if you want one — and the AI drafts the whole listing: title, category, condition, price and description. Most posts take well under a minute.',
      links: [{ href: '/marketplace', label: '⚡ Post in 60 seconds' }],
    };
  }

  return {
    intent,
    reply: `I'm your marketplace specialist — ask me what something is worth, what's in demand, how your listings are doing, or tell me what you're hunting for. There ${available.length === 1 ? 'is 1 live listing' : `are ${available.length} live listings`} on the family board right now.`,
    links: [{ href: '/marketplace/browse', label: 'Browse the board' }, { href: '/marketplace/insights', label: 'Market pulse' }],
  };
}

// ── LLM tier: the grounded system prompt ─────────────────────────────────────

/**
 * Compact, grounded system prompt for the key-configured tier. Embeds a digest
 * of the live snapshot so the model answers with REAL numbers, and pins the
 * assistant to marketplace scope with honest-fallback instructions.
 */
export function marketSystemPrompt(snapshot: MarketSnapshot): string {
  const available = snapshot.listings.filter((l) => l.status === 'available');
  const byCat = new Map<string, { n: number; priced: number[] }>();
  for (const l of available) {
    const e = byCat.get(l.category) ?? { n: 0, priced: [] };
    e.n++;
    if (l.kind === 'sell' && (l.price_cents ?? 0) > 0) e.priced.push(l.price_cents as number);
    byCat.set(l.category, e);
  }
  const catLines = [...byCat.entries()].map(([c, e]) => {
    const med = e.priced.sort((a, b) => a - b)[Math.floor(e.priced.length / 2)];
    return `- ${c}: ${e.n} live${e.priced.length ? `, median asking ${dollars(med)}` : ''}`;
  }).join('\n');
  const wanted = available.filter((l) => l.kind === 'wanted').slice(0, 10).map((l) => `- ${l.title}`).join('\n');

  return [
    'You are the Bubaly Family Marketplace specialist. Answer ONLY marketplace questions (pricing, finding items, selling, demand, fees, safety); politely redirect anything else.',
    'Ground every number in the snapshot below — never invent listings or prices. Keep replies under 80 words, warm and practical.',
    'Fees: family sales carry no commission; an optional admin-enabled service fee is always disclosed on the order.',
    '',
    `LIVE BOARD (${available.length} available listings):`,
    catLines || '- (board is empty)',
    wanted ? `\nOPEN REQUESTS:\n${wanted}` : '',
  ].filter(Boolean).join('\n');
}
