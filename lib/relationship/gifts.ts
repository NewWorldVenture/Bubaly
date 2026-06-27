// lib/relationship/gifts.ts — pure gift-suggestion logic + the Relationship
// Helper AI prompt/parse. No DB, no SDK — fully unit-testable.

export type WishPriorityLite = 'low' | 'medium' | 'high';

export type WishItemLite = {
  id: string;
  title: string;
  url: string | null;
  /** Approximate price in DOLLARS (matches wishlist_items.price). */
  price: number | null;
  priority: WishPriorityLite;
  is_purchased: boolean;
  claimed_by: string | null;
};

export type GiftCandidate = {
  wishlistItemId: string;
  title: string;
  url: string | null;
  /** Price normalized to cents (or null). */
  priceCents: number | null;
  priority: WishPriorityLite;
};

const PRIORITY_RANK: Record<WishPriorityLite, number> = { high: 3, medium: 2, low: 1 };

/**
 * Rank a partner's wishlist into gift candidates: drop already-purchased or
 * claimed items, honor a max budget, and sort by priority then lowest price.
 */
export function suggestGiftsFromWishlist(
  items: WishItemLite[],
  opts: { maxBudgetCents?: number | null; limit?: number } = {},
): GiftCandidate[] {
  const limit = opts.limit ?? 6;
  const budget = opts.maxBudgetCents ?? null;
  const candidates = items
    .filter((it) => !it.is_purchased && !it.claimed_by)
    .map((it) => ({
      wishlistItemId: it.id,
      title: it.title,
      url: it.url,
      priceCents: it.price != null ? Math.round(it.price * 100) : null,
      priority: it.priority,
    }))
    .filter((c) => budget == null || c.priceCents == null || c.priceCents <= budget)
    .sort((a, b) => {
      const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (p !== 0) return p;
      return (a.priceCents ?? Number.MAX_SAFE_INTEGER) - (b.priceCents ?? Number.MAX_SAFE_INTEGER);
    });
  return candidates.slice(0, limit);
}

// ── Gift list summary (a lightweight shopping tracker) ───────────────────────

export type GiftLike = { status: string; price_cents: number | null };
export type GiftSummary = {
  total: number;
  /** Not yet bought: idea / saved / ordered. */
  open: number;
  /** Done: purchased / given. */
  done: number;
  /** Sum of priced open items. */
  openCents: number;
  /** Sum of priced done items. */
  spentCents: number;
};

const DONE_STATUSES = new Set(['purchased', 'given']);

export function summarizeGifts(gifts: GiftLike[]): GiftSummary {
  const s: GiftSummary = { total: gifts.length, open: 0, done: 0, openCents: 0, spentCents: 0 };
  for (const g of gifts) {
    const done = DONE_STATUSES.has(g.status);
    if (done) { s.done += 1; s.spentCents += g.price_cents ?? 0; }
    else { s.open += 1; s.openCents += g.price_cents ?? 0; }
  }
  return s;
}

// ── AI digest ────────────────────────────────────────────────────────────────

export type DigestUpcoming = {
  title: string;
  kind: string;
  countdown: string;       // e.g. "in 3 days"
  milestone?: string | null; // e.g. "5th anniversary"
};

export type RelationshipDigestInput = {
  partnerName: string | null;
  upcoming: DigestUpcoming[];
  interests: string[];
  loveLanguages: string[];
  giftBudgetCents: number | null;
  wishlist: { title: string; priceCents: number | null }[];
};

export type GiftIdea = { title: string; reason: string; estimatedPrice: string | null };
export type RelationshipDigest = {
  headline: string;
  prompts: string[];
  giftIdeas: GiftIdea[];
};

function dollars(cents: number | null): string {
  if (cents == null) return 'unknown';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function buildRelationshipDigestPrompt(input: RelationshipDigestInput): { system: string; user: string } {
  const system = `You are the Bubaly Relationship Helper — a warm, thoughtful companion that helps someone show up for their partner. You receive a snapshot of upcoming relationship dates and partner preferences, and return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "headline": "one warm sentence about what's coming up",
  "prompts": ["a specific, kind, actionable nudge for an upcoming date", "another"],
  "giftIdeas": [{ "title": "concrete gift idea", "reason": "why it fits them", "estimatedPrice": "$50" }]
}

Rules:
- Ground prompts in the actual upcoming dates and their countdowns. Mention milestones (e.g. "5th anniversary").
- Tailor gift ideas to the partner's interests, love languages, and budget when provided. Prefer thoughtful over expensive.
- If wishlist items are provided, you may reference them, but also offer 1-2 fresh ideas beyond the list.
- 2-4 prompts, 3-5 gift ideas. Warm and encouraging; never pushy or transactional.`;

  const name = input.partnerName?.trim() || 'your partner';
  const up = input.upcoming.length
    ? input.upcoming.map((u) => `- ${u.title} (${u.kind}) — ${u.countdown}${u.milestone ? `, ${u.milestone}` : ''}`).join('\n')
    : '- (no upcoming dates in the window)';
  const interests = input.interests.length ? input.interests.join(', ') : 'unknown';
  const love = input.loveLanguages.length ? input.loveLanguages.join(', ') : 'unknown';
  const budget = input.giftBudgetCents != null ? dollars(input.giftBudgetCents) : 'no set budget';
  const wl = input.wishlist.length
    ? input.wishlist.map((w) => `- ${w.title}${w.priceCents != null ? ` (${dollars(w.priceCents)})` : ''}`).join('\n')
    : '- (no wishlist items)';

  const user = `Partner: ${name}
Interests: ${interests}
Love languages: ${love}
Gift budget: ${budget}

Upcoming dates:
${up}

${name}'s wishlist:
${wl}

Return the relationship JSON now.`;
  return { system, user };
}

/** Robustly extract the first JSON object from a model response. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseRelationshipDigest(text: string): RelationshipDigest {
  const obj = extractJson(text) as Record<string, unknown> | null;
  const headline = typeof obj?.headline === 'string' ? obj.headline.trim() : '';
  const prompts = Array.isArray(obj?.prompts)
    ? (obj!.prompts as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
    : [];
  const giftIdeas = Array.isArray(obj?.giftIdeas)
    ? (obj!.giftIdeas as unknown[])
        .map((g) => {
          const o = g as Record<string, unknown>;
          const title = typeof o?.title === 'string' ? o.title.trim() : '';
          if (!title) return null;
          return {
            title,
            reason: typeof o?.reason === 'string' ? o.reason.trim() : '',
            estimatedPrice: typeof o?.estimatedPrice === 'string' ? o.estimatedPrice.trim() : null,
          } as GiftIdea;
        })
        .filter((g): g is GiftIdea => g !== null)
    : [];
  return { headline, prompts, giftIdeas };
}
